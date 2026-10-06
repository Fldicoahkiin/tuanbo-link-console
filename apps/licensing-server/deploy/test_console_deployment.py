import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from datetime import datetime, timedelta, timezone


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publish = load('publish_console_test', 'publish-console.py')
backup = load('backup_console_test', 'backup-console.py')


class ConsoleDeploymentTest(unittest.TestCase):
    def payload(self, path, extra=None, tamper=False):
        files = {name: b'content-' + name.encode() for name in publish.FILES - {'manifest.json'}}
        manifest = {'version': 1, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items() if name != 'console-bootstrap.js'}}
        files['manifest.json'] = json.dumps(manifest).encode()
        if tamper:
            files['console.js'] = b'changed'
        if extra:
            files[extra] = b'extra'
        with tarfile.open(path, 'w') as archive:
            for name, value in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_verified_files_and_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'bundle.tar'
            digest = self.payload(path)
            self.assertEqual(set(publish.read_release(path, digest)), publish.FILES)
            with self.assertRaisesRegex(RuntimeError, 'digest'):
                publish.read_release(path, '0' * 64)

    def test_reject_extra_path_and_asset_tampering(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'bundle.tar'
            for extra in ['../escape', '/etc/passwd', 'unlisted.js']:
                digest = self.payload(path, extra=extra)
                with self.assertRaisesRegex(RuntimeError, 'members'):
                    publish.read_release(path, digest)
            digest = self.payload(path, tamper=True)
            with self.assertRaisesRegex(RuntimeError, 'digest'):
                publish.read_release(path, digest)

    def test_sqlite_backup_preserves_wal_and_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            db = sqlite3.connect(root / 'source.db')
            try:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT)')
                db.execute('INSERT INTO sample VALUES(?,?)', ('order', 'retained'))
                db.commit()
                backup.snapshot(root / 'source.db', root / 'backup.db')
                backup.snapshot(root / 'backup.db', root / 'restore.db')
                restored = sqlite3.connect(root / 'restore.db')
                try:
                    self.assertEqual(restored.execute('SELECT * FROM sample').fetchall(), [('order', 'retained')])
                finally:
                    restored.close()
            finally:
                db.close()

    def test_retention_only_removes_owned_old_backup_names(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            now = datetime.now(timezone.utc)
            def name(days):
                return 'console-' + (now - timedelta(days=days)).strftime('%Y%m%dT%H%M%SZ') + '-' + 'a' * 32 + '.tar.age'
            old = root / name(31)
            recent = root / name(1)
            other = root / 'customer-important-file'
            for path in [old, recent, other]:
                path.write_bytes(b'preserve')
            backup.prune(root, now)
            self.assertFalse(old.exists())
            self.assertTrue(recent.exists())
            self.assertTrue(other.exists())

    def test_offsite_must_be_mounted(self):
        with self.assertRaisesRegex(RuntimeError, 'mounted'):
            backup.backup({'ageRecipient': 'age1' + 'a' * 58, 'offsiteMount': '/not-a-real-mount', 'offsiteDirectory': '/not-a-real-mount/backups'})


if __name__ == '__main__':
    unittest.main()
