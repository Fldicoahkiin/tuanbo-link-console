from contextlib import closing, nullcontext
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('verify_console_backup_test', Path(__file__).with_name('verify-console-backup.py'))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RestoreBackupTest(unittest.TestCase):
    def archive(self, root, extra=None, recovery=None):
        database = root / 'source.db'
        with closing(sqlite3.connect(database)) as db, db:
            for table in ['orders', 'licenses', 'payment_receipts', 'console_users', 'console_audit']:
                db.execute('CREATE TABLE ' + table + ' (id INTEGER PRIMARY KEY)')
                db.execute('INSERT INTO ' + table + ' VALUES(1)')
        files = {'license.db': database.read_bytes(), 'keys/server.env': b'test fixture, not production credentials'}
        if extra:
            files.update(extra)
        if recovery is not None:
            files['delivery-recovery.db'] = recovery
        files['manifest.json'] = json.dumps({'version': 1, 'files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}).encode()
        archive = root / 'fixture.tar'
        with tarfile.open(archive, 'w') as tar:
            for name, value in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(value)
                tar.addfile(entry, io.BytesIO(value))
        return archive

    def verify_plain_fixture(self, archive, stage):
        stage.mkdir()
        # Only extraction/verification is under test here; this is not an age encryption drill.
        def decrypt(args, **_options):
            shutil.copyfile(archive, args[args.index('-o') + 1])
        with patch.object(restore.subprocess, 'run', side_effect=decrypt), patch.object(restore.tempfile, 'TemporaryDirectory', return_value=nullcontext(str(stage))):
            return restore.verify(archive, Path('unused-test-identity'))

    def test_restores_valid_database_and_keys_without_production_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root)
            before = (root / 'source.db').read_bytes()
            result = self.verify_plain_fixture(archive, root / 'restore')
            self.assertEqual(result['status'], 'success')
            self.assertFalse(result['productionModified'])
            self.assertEqual(result['counts']['orders'], 1)
            self.assertEqual((root / 'source.db').read_bytes(), before)

    def test_rejects_windows_traversal_drives_streams_and_reserved_paths(self):
        for name in ['keys/..\\..\\escape', 'keys/C:\\escape', 'keys/file:stream', 'keys/CON', 'keys/NUL.txt',
                     'keys/COM1', 'keys/key.', 'keys/key ', 'keys//key', 'keys/./key', '../escape', '/escape']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                sentinel = root / 'escape'
                sentinel.write_bytes(b'keep')
                archive = self.archive(root, {name: b'changed'})
                with self.assertRaisesRegex(RuntimeError, 'restore member'):
                    self.verify_plain_fixture(archive, root / 'restore')
                self.assertEqual(sentinel.read_bytes(), b'keep')

    def test_corrupt_recovery_database_is_not_accepted_with_a_matching_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root, recovery=b'not a SQLite database')
            with self.assertRaises(sqlite3.DatabaseError):
                self.verify_plain_fixture(archive, root / 'restore')

    def test_valid_recovery_database_is_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with closing(sqlite3.connect(root / 'recovery.db')) as db, db:
                db.execute('CREATE TABLE recovered_job (id INTEGER PRIMARY KEY)')
                db.execute('INSERT INTO recovered_job VALUES(1)')
            archive = self.archive(root, recovery=(root / 'recovery.db').read_bytes())
            self.assertEqual(self.verify_plain_fixture(archive, root / 'restore')['status'], 'success')

    @unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'requires real age tools')
    def test_real_age_round_trip_wrong_identity_and_corrupt_ciphertext(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root)
            identity, wrong = root / 'test-identity', root / 'wrong-identity'
            for target in [identity, wrong]:
                subprocess.run(['age-keygen', '-o', str(target)], check=True, capture_output=True, timeout=15)
            recipient = subprocess.run(['age-keygen', '-y', str(identity)], check=True, capture_output=True, text=True, timeout=15).stdout.strip()
            encrypted = root / 'fixture.tar.age'
            subprocess.run(['age', '-r', recipient, '-o', str(encrypted), str(archive)], check=True, capture_output=True, timeout=15)
            self.assertEqual(restore.verify(encrypted, identity)['counts']['licenses'], 1)
            with self.assertRaises(subprocess.CalledProcessError):
                restore.verify(encrypted, wrong)
            corrupted = bytearray(encrypted.read_bytes())
            corrupted[-1] ^= 1
            altered = root / 'corrupted.tar.age'
            altered.write_bytes(corrupted)
            with self.assertRaises(subprocess.CalledProcessError):
                restore.verify(altered, identity)


if __name__ == '__main__':
    unittest.main()
