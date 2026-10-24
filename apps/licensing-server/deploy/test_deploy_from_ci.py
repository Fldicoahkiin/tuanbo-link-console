import importlib.util
import io
import os
from pathlib import Path
import stat
import subprocess
import tarfile
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_from_ci', Path(__file__).with_name('deploy-from-ci.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SSHCredentialTest(unittest.TestCase):
    def test_openssh_reads_secret_with_trimmed_final_newline(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(source)],
                           check=True, capture_output=True, timeout=10)
            secret = source.read_text().rstrip('\r\n')
            target = Path(directory) / 'identity'
            for suffix in ['', '\n', '\r\n', '\n\n']:
                with self.subTest(suffix=repr(suffix)):
                    module.write_ssh_file(target, secret + suffix)
                    result = subprocess.run(['ssh-keygen', '-y', '-P', '', '-f', str(target)],
                                            check=True, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.stdout.split()[:2], source.with_suffix('.pub').read_text().split()[:2])
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)


class DeltaUploadTest(unittest.TestCase):
    files = {'dist/index.js': b'bundle', 'web/index.html': b'page', 'web/media/demo.mp4': b'large video'}
    manifest = {'revision': 'a' * 40, 'files': {}}

    def deliver(self, *replies):
        sent = []

        def send(payload, timeout):
            with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
                sent.append((sorted(archive.getnames()), timeout))
            return replies[len(sent) - 1]

        return module.deliver(send, self.files, self.manifest), sent

    def test_uploads_only_artifacts_production_lacks(self):
        result, sent = self.deliver({'status': 'plan', 'upload': ['web/index.html']}, {'status': 'success'})
        self.assertEqual(result, {'status': 'success'})
        self.assertEqual(sent, [(['manifest.json'], 120), (['manifest.json', 'web/index.html'], 2460)])

    def test_skips_upload_when_production_already_matches(self):
        result, sent = self.deliver({'status': 'plan', 'upload': []})
        self.assertIsNone(result)
        self.assertEqual(len(sent), 1)

    def test_rejects_unknown_or_malformed_plan(self):
        for reply in [{'status': 'plan', 'upload': ['../escape']}, {'status': 'success'}, {'status': 'plan', 'upload': 'all'}]:
            with self.subTest(reply=reply), self.assertRaisesRegex(RuntimeError, 'invalid upload plan'):
                self.deliver(reply)



class SourceTest(unittest.TestCase):
    def test_only_the_production_repository_and_branch_deploy(self):
        # The repository moved from JinHe9527 to Fldicoahkiin; the old name, forks and other branches never deploy.
        for repository, ref in [('JinHe9527/tuanbo-link-console', 'refs/heads/master'), ('someone/tuanbo-link-console', 'refs/heads/master'),
                                ('Fldicoahkiin/tuanbo-link-console', 'refs/heads/feature')]:
            with self.subTest(repository=repository, ref=ref), \
                    patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40, 'GITHUB_REPOSITORY': repository, 'GITHUB_REF': ref}), \
                    patch.object(module.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'Only the production repository and branch may deploy'):
                    module.main()
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
