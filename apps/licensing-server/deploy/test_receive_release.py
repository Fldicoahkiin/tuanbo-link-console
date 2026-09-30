import hashlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import tarfile
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('receive_release', HERE / 'receive-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def payload(change=None, extra=None, link=None):
    files = {name: ('content:' + name).encode() for name in module.ARTIFACTS}
    manifest = {'revision': 'a' * 40, 'repository': 'JinHe9527/tuanbo-link-console',
                'runId': 500, 'attempt': 1,
                'files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()},
                'tools': {name: 'b' * 64 for name in module.TOOLS}}
    if change:
        change(manifest, files)
    files['manifest.json'] = json.dumps(manifest).encode()
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w') as archive:
        for name, value in files.items():
            item = tarfile.TarInfo(name)
            item.size = len(value)
            if name == link:
                item.type = tarfile.SYMTYPE
                item.linkname = '/etc/passwd'
            archive.addfile(item, io.BytesIO(value))
        if extra:
            item = tarfile.TarInfo(extra)
            item.size = 1
            archive.addfile(item, io.BytesIO(b'x'))
    return data.getvalue(), manifest, files


class ReceiverTest(unittest.TestCase):
    def test_receive_stream_and_timeout_preserve_boundary(self):
        data, manifest, _ = payload()
        previous_handler = signal.getsignal(signal.SIGALRM)
        with TemporaryDirectory() as folder, patch.object(module, 'ROOT', Path(folder)):
            def start_worker(command, **kwargs):
                job = Path(folder) / 'jobs' / command[-1]
                self.assertEqual((job / 'incoming.tar').read_bytes(), data)
                (job / 'result.json').write_text(json.dumps({'revision': manifest['revision']}))

            with patch.object(module.subprocess, 'run', side_effect=start_worker):
                result = module.receive(io.BytesIO(data))
            self.assertEqual(result['revision'], manifest['revision'])
            self.assertEqual(signal.getsignal(signal.SIGALRM), previous_handler)

        class InterruptedUpload:
            calls = 0

            def read1(self, size):
                self.calls += 1
                if self.calls == 1:
                    return b'partial'
                signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)

        with TemporaryDirectory() as folder, patch.object(module, 'ROOT', Path(folder)):
            with self.assertRaisesRegex(TimeoutError, 'receiving 7 bytes'):
                module.receive(InterruptedUpload())
            self.assertFalse((Path(folder) / 'jobs').exists())
            self.assertEqual(signal.getsignal(signal.SIGALRM), previous_handler)

    def test_verified_archive_and_known_files_only(self):
        data, expected, files = payload()
        manifest, actual = module.decode_archive(data)
        self.assertEqual(manifest, expected)
        self.assertEqual(actual, {name: files[name] for name in module.ARTIFACTS})

    def test_no_symlink_extra_file_traversal_or_duplicate(self):
        for kwargs in [{'link': 'dist/index.js'}, {'extra': 'dist/index.js'},
                       {'extra': '../escape'}, {'extra': 'root-hook.py'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError):
                module.decode_archive(payload(**kwargs)[0])

    def test_digest_and_source_validation(self):
        changes = [lambda m, f: f.update({'dist/index.js': b'tampered'}),
                   lambda m, f: m.update(repository='other/repository'),
                   lambda m, f: m.update(revision='../../other'),
                   lambda m, f: m.update(runId=True),
                   lambda m, f: m.update(attempt=0),
                   lambda m, f: m['tools'].update({'activate-release.py': 'bad'}),
                   lambda m, f: m.update(extra='not allowed')]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                module.decode_archive(payload(change=change)[0])

    def test_bounded_archive_and_members(self):
        with self.assertRaisesRegex(RuntimeError, 'limit'):
            module.decode_archive(b'x' * (module.MAX_ARCHIVE + 1))
        with self.assertRaisesRegex(RuntimeError, 'member'):
            module.decode_archive(payload(change=lambda m, f: f.update({'dist/index.js': b'x' * 2_000_001}))[0])

    def test_policy_requires_installed_tools_and_reviewed_proxy(self):
        _, manifest, _ = payload()
        policy = {'nginxSha256': 'c' * 64}
        module.verify_policy(manifest, policy, manifest['tools'], 'c' * 64, None)
        with self.assertRaisesRegex(RuntimeError, 'operator-reviewed'):
            module.verify_policy(manifest, policy, {}, 'c' * 64, None)
        with self.assertRaisesRegex(RuntimeError, 'operator-reviewed'):
            module.verify_policy(manifest, policy, manifest['tools'], 'd' * 64, None)

    def test_no_replay_or_older_run_but_failed_attempt_can_retry(self):
        _, manifest, _ = payload()
        previous = {'runId': 500, 'attempt': 1}
        with self.assertRaisesRegex(RuntimeError, 'superseded'):
            module.verify_policy(manifest, {'nginxSha256': 'c'}, manifest['tools'], 'c', previous)
        manifest['runId'] = 499
        manifest['attempt'] = 10
        with self.assertRaisesRegex(RuntimeError, 'superseded'):
            module.verify_policy(manifest, {'nginxSha256': 'c'}, manifest['tools'], 'c', previous)
        manifest.update(runId=500, attempt=2)
        module.verify_policy(manifest, {'nginxSha256': 'c'}, manifest['tools'], 'c', previous)

    def test_job_records_only_complete_deployment_and_preserves_partial_evidence(self):
        for failure in [False, True]:
            with self.subTest(failure=failure), TemporaryDirectory() as folder:
                root = Path(folder)
                job = root / 'job'
                job.mkdir()
                data, manifest, files = payload()
                (job / 'incoming.tar').write_bytes(data)
                policy = root / 'policy.json'
                proxy = root / 'nginx.conf'
                proxy.write_text('existing proxy')
                policy.write_text(json.dumps({'nginxSha256': module.digest(proxy)}))
                env = root / 'environment'
                env.write_text('existing environment')
                bundle = root / 'bundle.js'
                bundle.write_text('old bundle')
                website = root / 'website'
                website.mkdir()
                tools = {name: root / name for name in manifest['tools']}
                for tool in tools.values():
                    tool.write_text('trusted operator-installed tool')
                data, manifest, files = payload(change=lambda m, f: m.update(tools={name: module.digest(p) for name, p in tools.items()}))
                (job / 'incoming.tar').write_bytes(data)

                def execute(name, *args):
                    with tarfile.open(args[0]) as archive:
                        self.assertEqual(archive.extractfile('nginx.next.conf').read(), b'existing proxy')
                    if name == 'activate-release.py':
                        bundle.write_bytes(files['dist/index.js'])
                        return {'backup': '/verified/runtime-backup'}
                    if failure:
                        raise RuntimeError('website failed')
                    for name in module.STATIC:
                        target = website / name
                        target.parent.mkdir(exist_ok=True)
                        target.write_bytes(files['web/' + name])
                    return {'backup': '/verified/website-backup'}

                with patch.multiple(module, ROOT=root, POLICY=policy, NGINX=proxy, ENVIRONMENT=env,
                                    BUNDLE=bundle, WEBSITE=website, TOOLS=tools), patch.object(module, 'execute', side_effect=execute):
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, 'website failed'):
                            module.activate_job(job)
                        self.assertFalse((root / 'last-success.json').exists())
                        self.assertFalse((job / 'result.json').exists())
                    else:
                        result = module.activate_job(job)
                        self.assertEqual(result['files'], manifest['files'])
                        self.assertEqual(json.loads((root / 'last-success.json').read_text()), result)
                    self.assertTrue((job / 'runtime-result.json').exists())
                    self.assertEqual(env.read_text(), 'existing environment')


if __name__ == '__main__':
    unittest.main()
