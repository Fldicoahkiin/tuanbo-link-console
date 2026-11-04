import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

spec = importlib.util.spec_from_file_location('publish_update', Path(__file__).with_name('publish-update.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

KEY = Ed25519PrivateKey.generate()


def release(directory, version, git='a' * 40, key=KEY, signed=True, installer_bytes=None):
    """A CI release directory as sign-release.mjs and write-release-manifest.mjs leave it."""
    directory.mkdir(parents=True)
    installer = f'Tuanbo-Link-Console-{version}-x64.exe'
    content = installer_bytes or f'installer {version}'.encode()
    sha512 = base64.b64encode(hashlib.sha512(content).digest()).decode()
    date = '2026-11-02T03:04:05.678Z'
    latest = f"version: {version}\nfiles:\n  - url: {installer}\n    sha512: {sha512}\n    size: {len(content)}\npath: {installer}\nsha512: {sha512}\nreleaseDate: '{date}'\n"
    if signed:
        payload = json.dumps({'schemaVersion': 1, 'product': 'tuanbo-link-console', 'channel': 'release', 'version': version, 'releaseDate': date,
                              'file': installer, 'size': len(content), 'sha512': sha512}, separators=(',', ':')).encode()
        encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        latest += f'tblinkRelease:\n  kid: release-test-a\n  payload: {encode(payload)}\n  signature: {encode(key.sign(payload))}\n'
    records = []
    for name, data in [(installer, content), (installer + '.blockmap', b'blockmap ' + version.encode()), ('latest.yml', latest.encode())]:
        (directory / name).write_bytes(data)
        records.append({'path': 'apps/desktop/dist/' + name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    manifest = {'version': version, 'gitSha': git, 'platform': 'win32', 'architecture': 'x64', 'gitWorkingTreeDirty': False,
                'summary': {'checksFailed': 0}, 'checks': [{'ok': True}], 'artifacts': records,
                'signing': {'authenticode': 'NotSigned'}, 'releaseSignature': {'kid': 'release-test-a'} if signed else None}
    (directory / 'release-manifest.json').write_text(json.dumps(manifest))
    return directory


class PublishUpdateTest(unittest.TestCase):
    def setUp(self):
        self.umask = os.umask(0o022)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        # In production root, tblink-license and tblink-release; here the test's own account plays all three.
        self.accounts = module.Accounts(os.getuid(), os.getuid(), os.getgid(), os.getuid())
        self.feed = self.root / module.FEED
        self.feed.mkdir(parents=True)
        self.publisher = self.root / module.PUBLISHER
        for name in ['results', 'work']:
            (self.publisher / name).mkdir(parents=True)
        self.receipts = self.root / module.RECEIPTS
        self.receipts.mkdir(parents=True)
        (self.root / module.REQUESTS).mkdir(parents=True)
        (self.root / module.STAGING).mkdir(parents=True)
        keys = self.root / module.KEYS
        keys.parent.mkdir(parents=True)
        keys.write_text(json.dumps({'release-test-a': KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()}))

    def tearDown(self):
        self.temporary.cleanup()
        os.umask(self.umask)

    def publish(self, source, version, git='a' * 40):
        return module.publish(source, module.digest(source / 'release-manifest.json').hexdigest(), git, version, self.root, self.accounts)

    def process(self):
        module.process_requests(self.root, self.accounts)

    def request(self, **values):
        request_id = str(uuid.uuid4())
        (self.root / module.REQUESTS / f'{request_id}.json').write_text(
            json.dumps({'id': request_id, 'actor': 'owner (9d53530a)', 'reason': '发布', 'requestedAt': '2026-10-23T08:00:00.000Z', **values}))
        self.process()
        return json.loads((self.publisher / 'results' / f'{request_id}.json').read_text())

    def status(self):
        return json.loads((self.publisher / 'update-status.json').read_text())

    def place_in_feed(self, source, version):
        """A release already on the feed from before this script (0.4.x was published by hand)."""
        installer = f'Tuanbo-Link-Console-{version}-x64.exe'
        for name in [installer, 'latest.yml']:
            (self.feed / name).write_bytes((source / name).read_bytes())

    def test_publish_preserves_previous_feed_and_refuses_overwrite(self):
        self.publish(release(self.root / 'one', '0.5.0'), '0.5.0')
        source = release(self.root / 'two', '0.5.1')
        result = self.publish(source, '0.5.1')
        self.assertEqual((self.feed / 'latest.yml').read_bytes(), (source / 'latest.yml').read_bytes())
        self.assertIn(b'version: 0.5.0', (Path(result['backup']) / 'previous-latest.yml').read_bytes())
        self.assertEqual((self.feed / 'latest.yml').stat().st_mode & 0o777, 0o644)
        with self.assertRaisesRegex(RuntimeError, '不高于当前更新源'):
            self.publish(source, '0.5.1')

    def test_corrupted_file_does_not_change_existing_feed(self):
        (self.feed / 'latest.yml').write_bytes(b"version: 0.4.29\nreleaseDate: '2026-09-28T18:15:14.517Z'\n")
        source = release(self.root / 'candidate', '0.5.0')
        (source / 'Tuanbo-Link-Console-0.5.0-x64.exe').write_bytes(b'corrupted')
        with self.assertRaisesRegex(RuntimeError, '产物与 manifest 不一致'):
            self.publish(source, '0.5.0')
        self.assertEqual(list(self.feed.iterdir()), [self.feed / 'latest.yml'])

    def test_different_commit_stops_before_publication(self):
        with self.assertRaisesRegex(RuntimeError, '构建来源信息不符'):
            self.publish(release(self.root / 'candidate', '0.5.0'), '0.5.0', 'b' * 40)
        self.assertEqual(list(self.feed.iterdir()), [])

    def test_unsigned_or_forged_releases_are_refused(self):
        with self.assertRaisesRegex(RuntimeError, '未签名的候选包'):
            self.publish(release(self.root / 'unsigned', '0.5.0', signed=False), '0.5.0')
        with self.assertRaisesRegex(RuntimeError, '发布签名无效'):
            self.publish(release(self.root / 'forged', '0.5.0', key=Ed25519PrivateKey.generate()), '0.5.0')
        # A latest.yml rewritten for another installer, with the manifest digests updated to match, still fails the signature.
        source = release(self.root / 'swapped', '0.5.0')
        other = release(self.root / 'other', '0.5.0', installer_bytes=b'another installer')
        for name in ['Tuanbo-Link-Console-0.5.0-x64.exe', 'release-manifest.json']:
            (source / name).write_bytes((other / name).read_bytes())
        latest = (source / 'latest.yml').read_text()
        other_sha512 = base64.b64encode(hashlib.sha512(b'another installer').digest()).decode()
        original_sha512 = base64.b64encode(hashlib.sha512(b'installer 0.5.0').digest()).decode()
        (source / 'latest.yml').write_text(latest.replace(original_sha512, other_sha512).replace('size: 15', f'size: {len(b"another installer")}'))
        manifest = json.loads((source / 'release-manifest.json').read_text())
        manifest['artifacts'][2] = {'path': 'apps/desktop/dist/latest.yml', 'bytes': len((source / 'latest.yml').read_bytes()), 'sha256': hashlib.sha256((source / 'latest.yml').read_bytes()).hexdigest()}
        (source / 'release-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, '发布签名与安装包不一致'):
            self.publish(source, '0.5.0')
        self.assertEqual(list(self.feed.iterdir()), [])

    def audit(self):
        return [json.loads(line) for line in (self.root / module.AUDIT).read_text().splitlines()]

    def test_a_staged_release_goes_live_on_its_own_and_a_failed_upload_is_tried_once(self):
        staged = release(self.root / module.STAGING / '0.5.0-aaaaaaaaaaaa', '0.5.0')
        self.process()
        self.assertFalse(staged.exists())
        self.assertEqual(self.status()['feed']['version'], '0.5.0')
        self.assertTrue(self.status()['feed']['signed'])
        self.assertEqual(self.status()['staged'], [])
        self.assertEqual({key: self.status()['autoPublish'][key] for key in ('name', 'ok', 'message')},
                         {'name': '0.5.0-aaaaaaaaaaaa', 'ok': True, 'message': '已自动发布 0.5.0'})
        self.assertEqual([(entry['action'], entry['version'], entry['ok'], entry['actor']) for entry in self.audit()],
                         [('auto-publish', '0.5.0', True, module.AUTO_ACTOR)])
        # The console reads the status through its group; nobody else can.
        self.assertEqual((self.publisher / 'update-status.json').stat().st_mode & 0o777, 0o640)
        self.assertEqual(list((self.publisher / 'work').iterdir()), [])

        broken = release(self.root / module.STAGING / '0.5.1-bbbbbbbbbbbb', '0.5.1')
        (broken / 'Tuanbo-Link-Console-0.5.1-x64.exe').write_bytes(b'corrupted')
        self.process()
        self.assertEqual(self.status()['feed']['version'], '0.5.0')
        self.assertEqual(self.status()['autoPublish']['message'], '0.5.1-bbbbbbbbbbbb 没有自动发布：产物与 manifest 不一致：Tuanbo-Link-Console-0.5.1-x64.exe')
        self.assertFalse(self.status()['autoPublish']['ok'])
        # The same upload is not tried again on every run.
        self.process()
        self.assertEqual(len(self.audit()), 2)
        # A new upload of that version is.
        shutil.rmtree(broken)
        release(broken, '0.5.1')
        self.process()
        self.assertEqual(self.status()['feed']['version'], '0.5.1')
        self.assertEqual([(entry['version'], entry['ok']) for entry in self.audit()], [('0.5.0', True), (None, False), ('0.5.1', True)])

    def test_only_the_owner_puts_back_a_version_that_was_rolled_back(self):
        self.publish(release(self.root / 'one', '0.5.0'), '0.5.0')
        self.publish(release(self.root / 'two', '0.5.1'), '0.5.1')
        self.assertTrue(self.request(action='rollback', version='0.5.0')['ok'])
        # The release workflow run again: the withdrawn version is staged once more, and a lower one too.
        staged = release(self.root / module.STAGING / '0.5.1-aaaaaaaaaaaa', '0.5.1')
        release(self.root / module.STAGING / '0.4.9-aaaaaaaaaaaa', '0.4.9')
        self.process()
        self.assertEqual(self.status()['feed']['version'], '0.5.0')
        self.assertIsNone(self.status()['autoPublish'])
        self.assertEqual([(entry['name'], entry['issue']) for entry in self.status()['staged']], [
            ('0.4.9-aaaaaaaaaaaa', '版本 0.4.9 不高于当前更新源（0.5.0）'), ('0.5.1-aaaaaaaaaaaa', None)])
        manifest_sha = module.digest(staged / 'release-manifest.json').hexdigest()
        result = self.request(action='publish', staged='0.5.1-aaaaaaaaaaaa', manifestSha256='0' * 64)
        self.assertEqual((result['ok'], result['message']), (False, '待发布版本的 manifest 与确认时不一致'))
        result = self.request(action='publish', staged='0.5.1-aaaaaaaaaaaa', manifestSha256=manifest_sha)
        self.assertEqual((result['ok'], result['message']), (True, '已发布 0.5.1'))
        self.assertFalse(staged.exists())
        self.assertEqual(self.status()['feed']['version'], '0.5.1')
        audit = self.audit()
        self.assertEqual(audit[-1]['actor'], 'owner (9d53530a)')
        self.assertEqual(audit[-1]['requestedAt'], '2026-10-23T08:00:00.000Z')

    def test_a_staged_directory_named_for_another_version_is_not_published(self):
        release(self.root / module.STAGING / '0.6.0-aaaaaaaaaaaa', '0.5.0')
        self.process()
        self.assertFalse((self.feed / 'latest.yml').exists())
        self.assertEqual(self.status()['autoPublish']['message'], '0.6.0-aaaaaaaaaaaa 没有自动发布：待发布目录名与版本不符')

    def test_rollback_returns_to_the_previous_feed_once(self):
        self.publish(release(self.root / 'one', '0.5.0'), '0.5.0')
        self.publish(release(self.root / 'two', '0.5.1'), '0.5.1')
        module.refresh_status(self.root, self.accounts)
        self.assertEqual(self.status()['rollback'], {'version': '0.5.0', 'issue': None})
        self.assertEqual(self.request(action='rollback', version='0.4.9')['message'], '回滚目标与确认时不一致')
        result = self.request(action='rollback', version='0.5.0')
        self.assertEqual((result['ok'], result['message']), (True, '更新源已回到 0.5.0，已移出更新源：0.5.1'))
        self.assertIn(b'version: 0.5.0', (self.feed / 'latest.yml').read_bytes())
        # The withdrawn version leaves the feed, blockmap too; it is kept in the rollback's receipt.
        self.assertEqual(self.feed_versions(), ['0.5.0'])
        self.assertEqual(self.feed_blockmaps(), ['0.5.0'])
        self.assertEqual(self.archived('rollback', '0.5.0'), ['Tuanbo-Link-Console-0.5.1-x64.exe', 'Tuanbo-Link-Console-0.5.1-x64.exe.blockmap'])
        # 0.5.0 was the first publish here: nothing earlier to return to.
        self.assertEqual(self.status()['rollback'], {'version': None, 'issue': '没有可以回滚到的上一版'})
        again = self.request(action='rollback', version='0.5.0')
        self.assertEqual((again['ok'], again['message']), (False, '没有可以回滚到的上一版'))

    def feed_versions(self):
        """The versions whose installers the feed serves."""
        return sorted(path.name.split('-')[3] for path in self.feed.iterdir() if path.name.startswith('Tuanbo-Link-Console-') and path.name.endswith('.exe'))

    def feed_blockmaps(self):
        return sorted(path.name.split('-')[3] for path in self.feed.iterdir() if path.name.startswith('Tuanbo-Link-Console-') and path.name.endswith('.blockmap'))

    def archived(self, kind, version):
        receipts = [path for path in self.receipts.iterdir() if path.name.endswith(f'-{kind}-{version}')]
        self.assertEqual(len(receipts), 1)
        return sorted(path.name for path in (receipts[0] / 'archived').iterdir()) if (receipts[0] / 'archived').exists() else []

    def test_feed_keeps_the_latest_version_and_the_one_it_replaced(self):
        oldest = release(self.root / 'oldest', '0.4.29', signed=False)
        self.place_in_feed(oldest, '0.4.29')
        (self.feed / 'Tuanbo-Link-Console-0.4.29-x64.exe.blockmap').write_bytes(b'old blockmap')
        self.publish(release(self.root / 'one', '0.5.0'), '0.5.0')
        # The replaced version stays: one-step rollback needs its installer, differential updates from it its blockmap.
        self.assertEqual(self.feed_versions(), ['0.4.29', '0.5.0'])
        self.assertEqual(self.archived('update', '0.5.0'), [])
        staged = release(self.root / module.STAGING / '0.5.1-aaaaaaaaaaaa', '0.5.1')
        result = self.request(action='publish', staged='0.5.1-aaaaaaaaaaaa', manifestSha256=module.digest(staged / 'release-manifest.json').hexdigest())
        self.assertEqual((result['ok'], result['message']), (True, '已发布 0.5.1，已移出更新源：0.4.29'))
        self.assertEqual(self.feed_versions(), ['0.5.0', '0.5.1'])
        # Moved, not deleted: the installer is in the publish receipt, out of public reach.
        archived = sorted(path for path in self.receipts.glob('*-update-0.5.1/archived/*'))
        self.assertEqual([path.name for path in archived], ['Tuanbo-Link-Console-0.4.29-x64.exe'])
        self.assertEqual(archived[0].read_bytes(), (oldest / 'Tuanbo-Link-Console-0.4.29-x64.exe').read_bytes())
        # Every blockmap stays: a computer still on 0.4.29 that was installed from the website downloads only
        # the changed blocks.
        self.assertEqual(self.feed_blockmaps(), ['0.4.29', '0.5.0', '0.5.1'])
        self.assertEqual((self.feed / 'Tuanbo-Link-Console-0.4.29-x64.exe.blockmap').read_bytes(), b'old blockmap')
        self.assertEqual(self.status()['rollback'], {'version': '0.5.0', 'issue': None})

    def test_only_the_newest_archives_keep_their_installers(self):
        self.publish(release(self.root / 'base-a', '0.5.0'), '0.5.0')
        self.publish(release(self.root / 'base-b', '0.5.1'), '0.5.1')
        # Each later publish archives one version (0.5.2 archives 0.5.0); the fourth archive prunes the first.
        for patch in range(2, 6):
            result = self.publish(release(self.root / f'p{patch}', f'0.5.{patch}'), f'0.5.{patch}')
        self.assertEqual(self.feed_versions(), ['0.5.4', '0.5.5'])
        holders = sorted(path.parent.name.split('-update-')[1] for path in self.receipts.glob('*-update-*/archived'))
        self.assertEqual(holders, ['0.5.3', '0.5.4', '0.5.5'])
        self.assertEqual([name.split('-update-')[1] for name in result['prunedArchives']], ['0.5.2'])
        self.assertEqual(json.loads(next(self.receipts.glob('*-update-0.5.4/receipt.json')).read_text())['prunedArchives'], [])
        # The pruned receipt keeps its record, so 0.5.2 still counts as published once.
        self.assertIsNotNone(module.publish_receipt(self.root, '0.5.2'))

    def test_blockmaps_an_earlier_publish_moved_off_the_feed_come_back_once(self):
        for patch in range(0, 4):
            self.publish(release(self.root / f'p{patch}', f'0.5.{patch}'), f'0.5.{patch}')
        self.assertTrue(self.request(action='rollback', version='0.5.2')['ok'])
        self.assertEqual(self.feed_blockmaps(), ['0.5.0', '0.5.1', '0.5.2'])
        # Before blockmaps stayed, a publish moved them into its receipt with the installer.
        receipt = next(self.receipts.glob('*-update-0.5.2'))
        (receipt / 'archived').mkdir(exist_ok=True)
        for version in ['0.5.0', '0.5.1']:
            name = f'Tuanbo-Link-Console-{version}-x64.exe.blockmap'
            shutil.move(self.feed / name, receipt / 'archived' / name)
        # A copy that does not match its manifest stays where it is.
        (receipt / 'archived' / 'Tuanbo-Link-Console-0.5.1-x64.exe.blockmap').write_bytes(b'changed')
        self.assertEqual(module.restore_blockmaps(self.root, self.accounts), ['Tuanbo-Link-Console-0.5.0-x64.exe.blockmap'])
        self.assertEqual((self.feed / 'Tuanbo-Link-Console-0.5.0-x64.exe.blockmap').read_bytes(), b'blockmap 0.5.0')
        self.assertEqual(oct((self.feed / 'Tuanbo-Link-Console-0.5.0-x64.exe.blockmap').stat().st_mode & 0o777), '0o644')
        # 0.5.3 was withdrawn by the rollback and stays off, so it can be published again.
        self.assertEqual(self.feed_blockmaps(), ['0.5.0', '0.5.2'])
        self.assertEqual(module.restore_blockmaps(self.root, self.accounts), [])

    def test_publishing_is_refused_when_the_disk_is_nearly_full(self):
        self.publish(release(self.root / 'one', '0.5.0'), '0.5.0')
        minimum = module.MIN_FREE_BYTES
        module.MIN_FREE_BYTES = shutil.disk_usage(self.root).free + 1024 ** 3
        try:
            with self.assertRaisesRegex(RuntimeError, '磁盘余量不足'):
                self.publish(release(self.root / 'two', '0.5.1'), '0.5.1')
            release(self.root / module.STAGING / '0.5.1-aaaaaaaaaaaa', '0.5.1')
            self.process()
            self.assertIn('磁盘余量不足', self.status()['autoPublish']['message'])
        finally:
            module.MIN_FREE_BYTES = minimum
        self.assertEqual(self.feed_versions(), ['0.5.0'])
        self.assertEqual(list((self.publisher / 'work').iterdir()), [])

    def test_accepts_the_signature_the_build_script_writes(self):
        # scripts/sign-release.mjs signs in Node; the payload bytes must match what this script rebuilds.
        repository = Path(__file__).resolve().parents[3]
        source = self.root / 'node-signed'
        source.mkdir()
        script = '''
import { createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const { signUpdateMetadata } = await import(process.argv[1]);
const [directory, pem, publicPem] = process.argv.slice(2);
const name = 'Tuanbo-Link-Console-0.5.0-x64.exe';
const text = readFileSync(`${directory}/latest.yml`, 'utf8');
writeFileSync(`${directory}/latest.yml`, signUpdateMetadata(text, { installerName: name, installerBytes: readFileSync(`${directory}/${name}`),
  privateKey: createPrivateKey(pem), kid: 'release-test-a', publicKeys: { 'release-test-a': publicPem } }));
'''
        unsigned = release(self.root / 'unsigned-source', '0.5.0', signed=False)
        for name in ['Tuanbo-Link-Console-0.5.0-x64.exe', 'latest.yml']:
            (source / name).write_bytes((unsigned / name).read_bytes())
        private = KEY.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
        public = KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
        subprocess.run(['node', '--input-type=module', '-e', script, (repository / 'scripts/release-config.mjs').as_uri(), str(source), private, public],
                       check=True, timeout=60, capture_output=True)
        data = (source / 'Tuanbo-Link-Console-0.5.0-x64.exe').read_bytes()
        metadata = module.feed_metadata((source / 'latest.yml').read_text())
        self.assertEqual(module.verify_signature(metadata, 'Tuanbo-Link-Console-0.5.0-x64.exe', len(data), base64.b64encode(hashlib.sha512(data).digest()).decode(), self.root), 'release-test-a')

    def test_discard_and_malformed_requests(self):
        # Unsigned, so it does not go live on its own and stays staged until discarded.
        staged = release(self.root / module.STAGING / '0.5.0-bbbbbbbbbbbb', '0.5.0', signed=False)
        self.assertEqual(self.request(action='discard', staged='../../etc')['message'], '请求内容无效')
        self.assertEqual(self.request(action='discard', staged='0.5.0-bbbbbbbbbbbb')['ok'], True)
        self.assertFalse(staged.exists())
        requests = self.root / module.REQUESTS
        results = self.publisher / 'results'
        # A link to another file is not followed.
        linked = str(uuid.uuid4())
        target = self.root / 'secret.json'
        target.write_text(json.dumps({'id': linked, 'action': 'discard', 'staged': '0.5.0-bbbbbbbbbbbb', 'actor': 'x', 'reason': 'y', 'requestedAt': '2026-10-23T08:00:00.000Z'}))
        os.symlink(target, requests / f'{linked}.json')
        # A field the schema does not allow.
        extra = str(uuid.uuid4())
        (requests / f'{extra}.json').write_text(json.dumps({'id': extra, 'action': 'rollback', 'version': '0.5.0', 'actor': 'x', 'reason': 'y', 'requestedAt': '2026-10-23T08:00:00.000Z', 'path': '/etc'}))
        self.process()
        self.assertEqual(json.loads((results / f'{linked}.json').read_text())['message'], '请求文件无效')
        self.assertEqual(json.loads((results / f'{extra}.json').read_text())['message'], '请求内容无效')
        # A file owned by another account.
        foreign = str(uuid.uuid4())
        (requests / f'{foreign}.json').write_text(json.dumps({'id': foreign, 'action': 'rollback', 'version': '0.5.0', 'actor': 'x', 'reason': 'y', 'requestedAt': '2026-10-23T08:00:00.000Z'}))
        descriptor = os.open(requests, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with self.assertRaisesRegex(RuntimeError, '请求文件无效'):
                module.read_request(descriptor, foreign, os.getuid() + 1)
        finally:
            os.close(descriptor)
        # The script never changes the console's request directory; a request with a result is not run again.
        self.assertTrue({f'{name}.json' for name in [linked, extra]} <= {path.name for path in requests.iterdir()})
        before = (results / f'{extra}.json').read_bytes()
        self.process()
        self.assertEqual((results / f'{extra}.json').read_bytes(), before)

    def test_rollback_reads_only_roots_receipts_and_needs_a_signed_previous_feed(self):
        old = release(self.root / 'old', '0.4.29', signed=False)
        self.place_in_feed(old, '0.4.29')
        # A forged receipt where receipts used to be kept: the console's account owns that directory.
        forged = self.root / 'var/lib/tblink-licensing/backups/20991231T000000Z-00000000-update-0.5.0'
        forged.mkdir(parents=True)
        (forged / 'receipt.json').write_text(json.dumps({'kind': 'publish', 'version': '0.5.0'}))
        (forged / 'previous-latest.yml').write_bytes((old / 'latest.yml').read_bytes())
        (self.feed / 'latest.yml').unlink()
        self.publish(release(self.root / 'one', '0.5.0'), '0.5.0')
        self.process()
        self.assertEqual(self.status()['rollback'], {'version': None, 'issue': '没有可以回滚到的上一版'})
        self.assertEqual(self.request(action='rollback', version='0.4.29')['message'], '没有可以回滚到的上一版')
        self.assertIn(b'version: 0.5.0', (self.feed / 'latest.yml').read_bytes())

    def test_rollback_refuses_an_unsigned_or_forged_previous_feed(self):
        for previous, issue in [(release(self.root / 'unsigned', '0.4.29', signed=False), '上一版没有发布签名，不能从后台回滚'),
                                (release(self.root / 'forged', '0.4.29', key=Ed25519PrivateKey.generate()), '上一版发布签名无效')]:
            with self.subTest(issue=issue):
                for path in self.feed.iterdir():
                    path.unlink()
                for path in self.receipts.iterdir():
                    shutil.rmtree(path)
                self.place_in_feed(previous, '0.4.29')
                self.publish(release(self.root / f'next-{uuid.uuid4().hex}', '0.5.0'), '0.5.0')
                self.process()
                self.assertEqual(self.status()['rollback'], {'version': '0.4.29', 'issue': issue})
                result = self.request(action='rollback', version='0.4.29')
                self.assertEqual((result['ok'], result['message']), (False, issue))
                self.assertIn(b'version: 0.5.0', (self.feed / 'latest.yml').read_bytes())

    def test_refuses_to_run_unless_its_directories_are_roots(self):
        for path, mode in [(self.publisher, 0o770), (self.feed, 0o757), (self.receipts, 0o775), (self.root / module.BACKUPS, 0o777)]:
            with self.subTest(path=path):
                path.chmod(mode)
                with self.assertRaisesRegex(RuntimeError, '目录不安全'):
                    self.process()
                path.chmod(0o755)
        (self.root / module.KEYS).chmod(0o664)
        with self.assertRaisesRegex(RuntimeError, '发布公钥文件不安全'):
            self.process()
        (self.root / module.KEYS).chmod(0o644)
        # A directory on the way replaced by a link, as the console's account could do inside its own directory.
        moved = self.root / 'moved-publisher'
        self.publisher.rename(moved)
        self.publisher.symlink_to(moved)
        with self.assertRaisesRegex(RuntimeError, '目录不安全'):
            self.process()

    def test_staging_and_request_links_are_not_followed(self):
        elsewhere = release(self.root / 'elsewhere', '0.5.0')
        os.symlink(elsewhere, self.root / module.STAGING / '0.5.0-cccccccccccc')
        inner = release(self.root / module.STAGING / '0.5.1-dddddddddddd', '0.5.1')
        installer = inner / 'Tuanbo-Link-Console-0.5.1-x64.exe'
        installer.rename(self.root / 'installer.exe')
        installer.symlink_to(self.root / 'installer.exe')
        self.process()
        self.assertEqual([(entry['name'], entry['issue']) for entry in self.status()['staged']], [
            ('0.5.0-cccccccccccc', '目录缺失或是链接：0.5.0-cccccccccccc'),
            ('0.5.1-dddddddddddd', '缺少文件或文件是链接：Tuanbo-Link-Console-0.5.1-x64.exe')])
        manifest_sha = module.digest(elsewhere / 'release-manifest.json').hexdigest()
        result = self.request(action='publish', staged='0.5.0-cccccccccccc', manifestSha256=manifest_sha)
        self.assertEqual((result['ok'], result['message']), (False, '目录缺失或是链接：0.5.0-cccccccccccc'))
        self.assertEqual(list(self.feed.iterdir()), [])
        for relative in [module.STAGING, module.REQUESTS]:
            with self.subTest(directory=relative):
                directory = self.root / relative
                directory.rename(directory.with_name('real'))
                directory.symlink_to(directory.with_name('real'))
                with self.assertRaisesRegex(RuntimeError, '目录缺失或是链接'):
                    self.process()
                directory.unlink()
                directory.with_name('real').rename(directory)

    def test_status_is_rebuilt_only_when_staging_or_the_feed_changes(self):
        self.process()
        status = self.publisher / 'update-status.json'
        first = status.stat().st_ino
        self.process()
        self.assertEqual(status.stat().st_ino, first)
        self.publish(release(self.root / 'one', '0.5.0'), '0.5.0')
        # Staged again after it went live: not above the feed, so it stays staged and is only listed.
        release(self.root / module.STAGING / '0.5.0-eeeeeeeeeeee', '0.5.0')
        self.process()
        self.assertNotEqual(status.stat().st_ino, first)
        self.assertEqual(self.status()['staged'][0]['issue'], '版本 0.5.0 不高于当前更新源（0.5.0）')
        second = status.stat().st_ino
        self.process()
        self.assertEqual(status.stat().st_ino, second)
        # A staged file rewritten in place changes its change time, so the entry is checked again.
        (self.root / module.STAGING / '0.5.0-eeeeeeeeeeee' / 'latest.yml').write_text('version: 0.5.0\n')
        self.process()
        self.assertNotEqual(status.stat().st_ino, second)
        self.assertEqual(self.status()['staged'][0]['issue'], '产物与 manifest 不一致：latest.yml')

if __name__ == '__main__':
    unittest.main()
