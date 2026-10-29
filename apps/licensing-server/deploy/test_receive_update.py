import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('receive_update', Path(__file__).with_name('receive-update.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

INSTALLER = 'Tuanbo-Link-Console-0.5.0-x64.exe'


BASE = 'Tuanbo-Link-Console-0.4.9-x64.exe'
BASE_BYTES = b'A' * 10 + b'B' * 10
NEW_BYTES = b'B' * 10 + b'NEW' + b'A' * 10
# NEW_BYTES built from BASE_BYTES: copy the Bs, send NEW, copy the As.
OPS = [[0, 10, 10], [1, 3], [0, 0, 10]]


def delta(ops=None, carried=b'NEW', base=None, size=len(NEW_BYTES), format=None):
    header = {'format': format or module.DELTA_FORMAT, 'base': base or {'file': BASE, 'size': len(BASE_BYTES)}, 'size': size, 'ops': OPS if ops is None else ops}
    return json.dumps(header).encode() + b'\n' + carried


def upload(files=None, signed=True, extra=None, tamper=None, members=None):
    files = files or {INSTALLER: b'installer', INSTALLER + '.blockmap': b'blockmap', 'latest.yml': b'version: 0.5.0\n'}
    manifest = {'version': '0.5.0', 'gitSha': 'c' * 40, 'platform': 'win32', 'architecture': 'x64', 'gitWorkingTreeDirty': False,
                'summary': {'checksFailed': 0}, 'releaseSignature': {'kid': 'release-test-a'} if signed else None,
                'artifacts': [{'path': 'apps/desktop/dist/' + name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in files.items()]}
    members = {'release-manifest.json': json.dumps(manifest).encode(), **(members or files), **(extra or {}), **(tamper or {})}
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
        self.staging = Path(self.temporary.name) / 'staging'
        self.feed = Path(self.temporary.name) / 'feed'
        self.staging.mkdir()
        self.feed.mkdir()

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

    def test_status_lists_staged_entries_and_a_running_upload(self):
        module.receive(upload(), self.staging)
        (self.staging / '.incoming-0123').mkdir()
        self.assertEqual(module.status(self.staging), {'staged': ['0.5.0-cccccccccccc'], 'uploading': False, 'delta': module.DELTA_FORMAT})
        held = module.upload_lock(self.staging)
        try:
            self.assertEqual(module.status(self.staging)['uploading'], True)
            # A second upload, from another machine, is refused before it sends anything.
            self.assertIsNone(module.upload_lock(self.staging))
        finally:
            os.close(held)
        self.assertEqual(module.status(self.staging)['uploading'], False)

    def delta_upload(self, member=None, **change):
        files = {INSTALLER: NEW_BYTES, INSTALLER + '.blockmap': b'blockmap', 'latest.yml': b'version: 0.5.0\n'}
        members = {INSTALLER + '.blockmap': b'blockmap', 'latest.yml': b'version: 0.5.0\n', INSTALLER + '.delta': member if member is not None else delta(**change)}
        return upload(files=files, members=members)

    def test_an_installer_rebuilt_from_the_feed_lands_like_a_full_upload(self):
        (self.feed / BASE).write_bytes(BASE_BYTES)
        self.assertEqual(module.status(self.staging)['delta'], module.DELTA_FORMAT)
        result = module.receive(self.delta_upload(), self.staging, self.feed)
        entry = self.staging / '0.5.0-cccccccccccc'
        self.assertEqual(result['rebuiltFrom'], BASE)
        self.assertEqual(sorted(path.name for path in entry.iterdir()), sorted([INSTALLER, INSTALLER + '.blockmap', 'latest.yml', 'release-manifest.json']))
        self.assertEqual((entry / INSTALLER).read_bytes(), NEW_BYTES)
        self.assertEqual((self.feed / BASE).read_bytes(), BASE_BYTES)

    def test_a_delta_that_does_not_rebuild_the_installer_asks_for_the_full_one(self):
        (self.feed / BASE).write_bytes(BASE_BYTES)
        (self.feed / 'link.exe').symlink_to(self.feed / BASE)
        for upload_stream, reason in [
            (self.delta_upload(member=b'NEW'), 'header too large or cut off'),
            (self.delta_upload(format='tblink-installer-delta-0'), 'Unknown delta format'),
            (self.delta_upload(base={'file': '../../etc/passwd', 'size': 20}), 'Invalid delta header'),
            (self.delta_upload(ops=[[0, 15, 10], [1, 3], [0, 0, 10]]), 'Invalid delta operation'),
            (self.delta_upload(ops=[[True, 3], [0, 10, 10], [0, 0, 10]]), 'Invalid delta operation'),
            (self.delta_upload(carried=b'NEW!'), 'do not add up'),
            (self.delta_upload(ops=[[0, 10, 10], [1, 3], [0, 0, 9]]), 'do not add up'),
            (self.delta_upload(base={'file': 'Tuanbo-Link-Console-0.4.8-x64.exe', 'size': 20}), 'not on the feed'),
            (self.delta_upload(base={'file': BASE, 'size': 19}, ops=[[0, 9, 10], [1, 3], [0, 0, 10]]), 'feed differs'),
            (self.delta_upload(carried=b'OLD'), 'Rebuilt installer differs from manifest'),
        ]:
            with self.assertRaisesRegex(module.DeltaError, reason):
                module.receive(upload_stream, self.staging, self.feed)
            self.assertEqual(list(self.staging.iterdir()), [])
        os.rename(self.feed / 'link.exe', self.feed / 'Tuanbo-Link-Console-0.4.8-x64.exe')
        with self.assertRaisesRegex(module.DeltaError, 'not on the feed'):
            module.receive(self.delta_upload(base={'file': 'Tuanbo-Link-Console-0.4.8-x64.exe', 'size': 20}), self.staging, self.feed)

    def test_a_delta_beside_the_installer_is_refused_outright(self):
        (self.feed / BASE).write_bytes(BASE_BYTES)
        with self.assertRaisesRegex(RuntimeError, 'Unexpected upload files') as caught:
            module.receive(upload(extra={INSTALLER + '.delta': delta()}), self.staging, self.feed)
        self.assertNotIsInstance(caught.exception, module.DeltaError)
        self.assertEqual(list(self.staging.iterdir()), [])

    def test_the_lock_file_never_counts_as_a_staged_release(self):
        os.close(module.upload_lock(self.staging))
        for index in range(module.MAX_STAGED - 1):
            (self.staging / f'0.4.{index}-{"d" * 12}').mkdir()
        self.assertEqual(module.receive(upload(), self.staging)['staged'], '0.5.0-cccccccccccc')

if __name__ == '__main__':
    unittest.main()
