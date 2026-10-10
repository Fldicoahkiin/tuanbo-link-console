import importlib.util
from pathlib import Path
import stat
import os
import json
import hashlib
import ast
import unittest
from unittest.mock import patch
from tempfile import mkdtemp, TemporaryDirectory
import tarfile
from types import SimpleNamespace

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('publish_website', HERE / 'publish-website.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WebsiteConfigTest(unittest.TestCase):
    def setUp(self):
        self.previous = (HERE / 'nginx.conf').read_text()
        self.before, _, self.after = module.site_sections(self.previous)
        site = (HERE / 'purchase-site.conf').read_text()
        self.site = site[site.index('server {'):]
        self.candidate = self.before + self.site + self.after

    def test_only_website_changes(self):
        self.assertEqual(module.validate_config(self.previous, self.candidate), self.candidate)

    def test_upload_and_receiver_allowlists_match_publisher(self):
        for script in ['deploy-from-ci.py', 'receive-release.py']:
            values = set()
            for statement in ast.parse((HERE / script).read_text()).body:
                if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'STATIC' for target in statement.targets):
                    values.update(ast.literal_eval(statement.value))
                if isinstance(statement, ast.AugAssign) and isinstance(statement.target, ast.Name) and statement.target.id == 'STATIC':
                    values.update(ast.literal_eval(statement.value))
            self.assertEqual(values, module.STATIC_FILES, script)

    def test_other_sites_cannot_change(self):
        with self.assertRaisesRegex(RuntimeError, 'Only the website'):
            module.validate_config(self.previous, self.candidate.replace('root /srv/tblink-updates;', 'root /tmp/other;'))

    def test_rejects_admin_proxy_method_and_address_changes(self):
        for site in [self.site.replace('= /v1/catalog', '= /admin/orders'),
                     self.site.replace('limit_except POST', 'limit_except GET'),
                     self.site.replace('proxy_set_header X-Tblink-Client-IP $remote_addr;', '')]:
            with self.subTest(site=site), self.assertRaises(RuntimeError):
                module.validate_config(self.previous, self.before + site + self.after)

    def test_rejects_duplicate_host_and_missing_security(self):
        with self.assertRaises(RuntimeError):
            module.validate_config(self.previous, self.candidate + self.site)
        with self.assertRaisesRegex(RuntimeError, 'security header'):
            module.validate_config(self.previous, self.candidate.replace('Referrer-Policy no-referrer always', 'Referrer-Policy unsafe-url always'))

    def test_reload_waits_for_worker_to_serve_new_version(self):
        with patch.object(module, 'probe', side_effect=['old response', 'new response']) as probe, patch.object(module.time, 'sleep'):
            module.wait_for_page('new response')
            self.assertEqual(probe.call_count, 2)

    def test_wrong_page_never_passes_bounded_wait(self):
        with patch.object(module, 'probe', return_value='wrong response') as probe, patch.object(module.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'after reload'):
                module.wait_for_page('expected response')
            self.assertEqual(probe.call_count, 10)

    def test_manifest_rejects_tampering_and_unlisted_paths(self):
        with TemporaryDirectory(prefix='tblink-website-manifest-') as folder:
            root = Path(folder)
            files = {}
            for name in module.STATIC_FILES - {'website-manifest.json'}:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'original')
                files[name] = {'size': 8, 'sha256': module.digest(file)}
            manifest = root / 'website-manifest.json'
            manifest.write_text(json.dumps({'version': 1, 'files': files}))
            module.validate_files(root)
            (root / 'index.html').write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                module.validate_files(root)
            files['../outside'] = files['index.html']
            manifest.write_text(json.dumps({'version': 1, 'files': files}))
            with self.assertRaisesRegex(RuntimeError, 'allowlist'):
                module.validate_files(root)

    def test_video_requires_partial_response(self):
        with TemporaryDirectory(prefix='tblink-website-range-') as folder:
            root = Path(folder)
            (root / 'demo.mp4').write_bytes(b'x' * 2048)
            with patch.object(module, 'STATIC_FILES', {'demo.mp4'}), patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout=b'x' * 2048)), patch.object(module, 'run', return_value=SimpleNamespace(stdout='HTTP/1.1 200 OK\n')):
                with self.assertRaisesRegex(RuntimeError, 'range request failed'):
                    module.verify_live_files(root)
            with patch.object(module, 'STATIC_FILES', {'demo.mp4'}), patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout=b'x' * 2048)), patch.object(module, 'run', return_value=SimpleNamespace(stdout='HTTP/1.1 206 Partial Content\nContent-Range: bytes 0-1023/2048\n')):
                module.verify_live_files(root)

    @unittest.skipUnless(os.name == 'posix', 'Release symlink permissions and effective uid require POSIX')
    def test_failed_live_probe_restores_existing_root_and_proxy(self):
        for had_site in [False, True]:
            with self.subTest(had_site=had_site):
                folder = Path(mkdtemp(prefix='tblink-site-rollback-'))
                proxy = folder / 'nginx.conf'
                root = folder / 'site'
                releases = folder / 'releases'
                releases.mkdir()
                old = releases / 'old'
                if had_site:
                    old.mkdir()
                    (old / 'index.html').write_text('existing site')
                    root.symlink_to(old)
                backups = folder / 'backups'
                backups.mkdir()
                protected = [folder / 'bundle', folder / 'env']
                for path in protected:
                    path.write_text('unchanged')
                proxy.write_text(self.previous)
                package = folder / 'package'
                package.mkdir()
                candidate = self.candidate.replace('root /srv/tblink-purchase;', f'root {root};')
                content = {name: 'content:' + name for name in module.STATIC_FILES}
                content.update({'index.html': 'candidate site', 'revision.txt': 'a' * 40, 'nginx.previous.conf': self.previous, 'nginx.next.conf': candidate})
                content['website-manifest.json'] = json.dumps({'version': 1, 'files': {name: {'size': len(content[name].encode()), 'sha256': hashlib.sha256(content[name].encode()).hexdigest()} for name in module.STATIC_FILES - {'website-manifest.json'}}})
                archive = folder / 'release.tar'
                with tarfile.open(archive, 'w') as tar:
                    for name, value in content.items():
                        (package / name).parent.mkdir(exist_ok=True)
                        (package / name).write_text(value)
                        tar.add(package / name, arcname=name)
                args = ['publish-website.py', str(archive), module.digest(archive), module.digest(proxy)] + [module.digest(p) for p in protected]
                with patch.object(module, 'NGINX', proxy), patch.object(module, 'ROOT', root), patch.object(module, 'RELEASES', releases), patch.object(module, 'BACKUPS', backups), patch.object(module, 'PROTECTED', protected), patch.object(module.sys, 'argv', args), patch.object(module.os, 'geteuid', return_value=0), patch.object(module, 'read_catalog'), patch.object(module, 'run', return_value=SimpleNamespace(stdout='active')), patch.object(module, 'probe', side_effect=RuntimeError('simulated live probe failure')):
                    previous_mask = module.os.umask(0o077)
                    try:
                        with self.assertRaisesRegex(RuntimeError, 'simulated live probe failure'):
                            module.main()
                    finally:
                        module.os.umask(previous_mask)
                candidate_release = next(releases.glob('a' * 40 + '-*'))
                for directory in [candidate_release, candidate_release / 'assets']:
                    self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
                self.assertEqual(stat.S_IMODE(next(backups.iterdir()).stat().st_mode), 0o700)
                self.assertEqual(proxy.read_text(), self.previous)
                if had_site:
                    self.assertEqual(root.resolve(), old.resolve())
                    self.assertEqual((root / 'index.html').read_text(), 'existing site')
                else:
                    self.assertFalse(root.exists())
                    self.assertTrue(list(folder.glob('site.failed-*')))
                self.assertTrue(all(p.read_text() == 'unchanged' for p in protected))


if __name__ == '__main__':
    unittest.main()
