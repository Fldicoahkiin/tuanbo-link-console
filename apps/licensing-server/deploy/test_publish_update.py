import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publish_update', Path(__file__).with_name('publish-update.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublishUpdateTest(unittest.TestCase):
    def fixture(self, root):
        source = root / 'candidate'
        source.mkdir()
        destination = root / 'srv/tblink-updates/windows/x64'
        destination.mkdir(parents=True)
        (root / 'var/lib/tblink-licensing/backups').mkdir(parents=True)
        records = []
        for name, content in [('Tuanbo-Link-Console-0.4.28-x64.exe', b'installer fixture'),
                              ('Tuanbo-Link-Console-0.4.28-x64.exe.blockmap', b'blockmap fixture'),
                              ('latest.yml', b'version: 0.4.28\n')]:
            (source / name).write_bytes(content)
            records.append({'path': 'apps/desktop/dist/' + name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        manifest = {'version': '0.4.28', 'gitSha': 'a' * 40, 'platform': 'win32', 'architecture': 'x64',
                    'gitWorkingTreeDirty': False, 'summary': {'checksFailed': 0},
                    'checks': [{'ok': True}], 'artifacts': records, 'signing': {'expected': 'unsigned-candidate'}}
        (source / 'release-manifest.json').write_text(json.dumps(manifest))
        return source, destination

    def test_publish_preserves_previous_feed_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, destination = self.fixture(root)
            (destination / 'latest.yml').write_bytes(b'previous feed')
            digest = module.digest(source / 'release-manifest.json')
            result = module.publish(source, digest, 'a' * 40, '0.4.28', root)
            self.assertEqual((destination / 'latest.yml').read_bytes(), b'version: 0.4.28\n')
            self.assertEqual((Path(result['backup']) / 'previous-latest.yml').read_bytes(), b'previous feed')
            self.assertEqual((destination / 'latest.yml').stat().st_mode & 0o777, 0o644)
            with self.assertRaisesRegex(RuntimeError, 'already exist'):
                module.publish(source, digest, 'a' * 40, '0.4.28', root)

    def test_corrupted_file_does_not_change_existing_feed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, destination = self.fixture(root)
            (destination / 'latest.yml').write_bytes(b'previous feed')
            (source / 'Tuanbo-Link-Console-0.4.28-x64.exe').write_bytes(b'corrupted')
            with self.assertRaisesRegex(RuntimeError, 'artifact differs'):
                module.publish(source, module.digest(source / 'release-manifest.json'), 'a' * 40, '0.4.28', root)
            self.assertEqual(list(destination.iterdir()), [destination / 'latest.yml'])
            self.assertEqual((destination / 'latest.yml').read_bytes(), b'previous feed')

    def test_different_commit_stops_before_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, destination = self.fixture(root)
            with self.assertRaisesRegex(RuntimeError, 'provenance'):
                module.publish(source, module.digest(source / 'release-manifest.json'), 'b' * 40, '0.4.28', root)
            self.assertEqual(list(destination.iterdir()), [])
