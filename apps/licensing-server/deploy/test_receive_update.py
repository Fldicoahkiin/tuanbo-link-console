import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('receive_update', Path(__file__).with_name('receive-update.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

INSTALLER = 'Tuanbo-Link-Console-0.5.0-x64.exe'


def upload(files=None, signed=True, extra=None, tamper=None):
    files = files or {INSTALLER: b'installer', INSTALLER + '.blockmap': b'blockmap', 'latest.yml': b'version: 0.5.0\n'}
    manifest = {'version': '0.5.0', 'gitSha': 'c' * 40, 'platform': 'win32', 'architecture': 'x64', 'gitWorkingTreeDirty': False,
                'summary': {'checksFailed': 0}, 'releaseSignature': {'kid': 'release-test-a'} if signed else None,
                'artifacts': [{'path': 'apps/desktop/dist/' + name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in files.items()]}
    members = {'release-manifest.json': json.dumps(manifest).encode(), **files, **(extra or {}), **(tamper or {})}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    buffer.seek(0)
    return buffer


class ReceiveUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.staging = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_signed_release_lands_in_a_new_staging_entry(self):
        result = module.receive(upload(), self.staging)
        entry = self.staging / '0.5.0-cccccccccccc'
        self.assertEqual(result['staged'], entry.name)
        self.assertEqual(sorted(path.name for path in entry.iterdir()), sorted([INSTALLER, INSTALLER + '.blockmap', 'latest.yml', 'release-manifest.json']))
        self.assertEqual(result['manifestSha256'], hashlib.sha256((entry / 'release-manifest.json').read_bytes()).hexdigest())
        with self.assertRaisesRegex(RuntimeError, 'already staged'):
            module.receive(upload(), self.staging)
        self.assertEqual([path.name for path in self.staging.iterdir()], [entry.name])

    def test_rejected_uploads_leave_nothing_behind(self):
        for stream, reason in [
            (upload(signed=False), 'signed, fully checked'),
            (upload(extra={'run.sh': b'#!/bin/sh'}), 'Unexpected upload files'),
            (upload(tamper={INSTALLER: b'forged!!!'}), 'differs from manifest'),
        ]:
            with self.assertRaisesRegex(RuntimeError, reason):
                module.receive(stream, self.staging)
            self.assertEqual(list(self.staging.iterdir()), [])

    def test_refuses_more_staged_releases_than_the_console_can_review(self):
        for index in range(module.MAX_STAGED):
            (self.staging / f'0.4.{index}-{"d" * 12}').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'Too many staged releases'):
            module.receive(upload(), self.staging)


if __name__ == '__main__':
    unittest.main()
