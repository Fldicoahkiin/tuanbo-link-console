import importlib.util
from pathlib import Path
import stat
import subprocess
from tempfile import TemporaryDirectory
import unittest

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


if __name__ == '__main__':
    unittest.main()
