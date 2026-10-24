#!/usr/bin/env python3
"""Publish verified Windows releases; install immutable assets before replacing the feed.

Usage (root):
  publish-update.py <directory> <manifest_sha256> <git_sha> <version>   publish a reviewed directory by hand
  publish-update.py --process-requests                                    run the console's queued requests, then
                                                                          publish a newly staged release
A release the builder stages goes live on its own once it passes every check (tag = release). The console never
writes the feed: it queues a rollback, a discard or a manual publish; this script, started as root by
tblink-update-publish.path, re-validates everything and writes the result back.

Paths. Everything this script writes, or reads to decide what to trust, lies under directories that only root
can change, checked from / on every run: the feed, this script's own directory, root's backups (receipts and
the audit log) and the release public keys.
The two directories other accounts own are only read, through descriptors opened without following links and
checked for their owner: the console's request directory and the release builder's staging area. A staged
release is copied into root's work directory first; every check and the install read that copy only.
"""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
from typing import NamedTuple
import uuid

import yaml
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key

# Root's, from / down (checked by check_layout).
FEED = 'srv/tblink-updates/windows/x64'
KEYS = 'opt/tblink-licensing/release-public-keys.json'
PUBLISHER = 'var/lib/tblink-update-publish'
# Root's backups, shared with the deployment tools; never inside a service account's directory.
BACKUPS = 'var/backups/tblink'
RECEIPTS = BACKUPS + '/update-receipts'
AUDIT = BACKUPS + '/update-audit.jsonl'
# Owned by other accounts; read through checked descriptors only.
REQUESTS = 'var/lib/tblink-licensing/update-requests'
STAGING = 'var/lib/tblink-release/staging'
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
STAGED_NAME = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-[a-f0-9]{12}')
REQUEST_ID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
VERSIONED = re.compile(r'Tuanbo-Link-Console-((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))-x64\.exe(\.blockmap)?')
MAX_MANIFEST = 1024 * 1024
MAX_FILE = 2 * 1024 ** 3


class Accounts(NamedTuple):
    root: int
    console: int        # tblink-license writes requests; its group reads results and status
    console_group: int
    builder: int        # tblink-release owns the staging area


def system_accounts():
    return Accounts(0, pwd.getpwnam('tblink-license').pw_uid, grp.getgrnam('tblink-license').gr_gid,
                    pwd.getpwnam('tblink-release').pw_uid)


def require_root_directory(root, relative, accounts):
    """Every directory from root down to this one is root's and writable by no one else, so no other
    account can rename or replace anything on the way."""
    path = root
    for part in ('', *Path(relative).parts):
        path = path / part
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            raise RuntimeError('目录缺失：' + str(path)) from None
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != accounts.root or info.st_mode & 0o022:
            raise RuntimeError('目录不安全（必须是 root 所有、其他账号不可写的目录）：' + str(path))


def check_layout(root, accounts):
    for relative in (FEED, PUBLISHER, PUBLISHER + '/results', PUBLISHER + '/work', BACKUPS, RECEIPTS,
                     str(Path(STAGING).parent), str(Path(KEYS).parent)):
        require_root_directory(root, relative, accounts)
    keys = os.lstat(root / KEYS)
    if not stat.S_ISREG(keys.st_mode) or keys.st_uid != accounts.root or keys.st_mode & 0o022:
        raise RuntimeError('发布公钥文件不安全：' + str(root / KEYS))


def open_owned_directory(path, owner, dir_fd=None):
    """A directory another account owns, opened without following a link at its last step."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except OSError:
        raise RuntimeError('目录缺失或是链接：' + str(path)) from None
    if os.fstat(descriptor).st_uid != owner:
        os.close(descriptor)
        raise RuntimeError('目录属主不符：' + str(path))
    return descriptor


def digest(path, algorithm='sha256'):
    value = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value


def version_key(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise RuntimeError('版本号无效')
    return tuple(int(part) for part in version.split('.'))


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def feed_metadata(text):
    """latest.yml with a quoted releaseDate (an unquoted one would parse as a datetime)."""
    metadata = yaml.safe_load(text)
    if not isinstance(metadata, dict) or not isinstance(metadata.get('releaseDate'), str):
        raise RuntimeError('latest.yml 格式无效')
    return metadata


def current_feed(root):
    feed = root / FEED / 'latest.yml'
    if feed.is_symlink():
        raise RuntimeError('更新源 latest.yml 不能是链接')
    return feed_metadata(feed.read_text()) if feed.exists() else None


def copy_file(source_fd, name, work, limit):
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
    except OSError:
        raise RuntimeError('缺少文件或文件是链接：' + name) from None
    with os.fdopen(descriptor, 'rb') as incoming:
        info = os.fstat(incoming.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise RuntimeError('不是普通文件或超过大小上限：' + name)
        with (work / name).open('xb') as outgoing:
            copied = 0
            for chunk in iter(lambda: incoming.read(1024 * 1024), b''):
                copied += len(chunk)
                if copied > limit:
                    raise RuntimeError('超过大小上限：' + name)
                outgoing.write(chunk)


@contextmanager
def candidate(root, source_fd):
    """The release in source_fd, copied into a fresh work directory of root's: the manifest first, then the
    three files it names. Nothing is read from the source again, so it cannot change between check and use."""
    work = root / PUBLISHER / 'work' / uuid.uuid4().hex
    work.mkdir(mode=0o700)
    try:
        copy_file(source_fd, 'release-manifest.json', work, MAX_MANIFEST)
        try:
            version = json.loads((work / 'release-manifest.json').read_text()).get('version')
        except (ValueError, AttributeError):
            raise RuntimeError('manifest 格式无效') from None
        version_key(version)
        installer = f'Tuanbo-Link-Console-{version}-x64.exe'
        for name in (installer, installer + '.blockmap', 'latest.yml'):
            copy_file(source_fd, name, work, MAX_FILE)
        yield work
    finally:
        shutil.rmtree(work)


def verify_signature(metadata, installer_name, size, sha512, root):
    """The release key's signature over this installer; the client checks the same payload."""
    envelope = metadata.get('tblinkRelease')
    if not isinstance(envelope, dict) or set(envelope) != {'kid', 'payload', 'signature'}:
        raise RuntimeError('缺少发布签名')
    keys = json.loads((root / KEYS).read_text())
    if envelope['kid'] not in keys:
        raise RuntimeError('发布签名使用了未登记的密钥')
    payload = base64.urlsafe_b64decode(envelope['payload'] + '=' * (-len(envelope['payload']) % 4))
    signature = base64.urlsafe_b64decode(envelope['signature'] + '=' * (-len(envelope['signature']) % 4))
    try:
        load_pem_public_key(keys[envelope['kid']].encode()).verify(signature, payload)
    except InvalidSignature:
        raise RuntimeError('发布签名无效') from None
    expected = json.dumps({'schemaVersion': 1, 'product': 'tuanbo-link-console', 'channel': 'release', 'version': metadata['version'],
                           'releaseDate': metadata['releaseDate'], 'file': installer_name, 'size': size, 'sha512': sha512},
                          separators=(',', ':'), ensure_ascii=False).encode()
    if payload != expected:
        raise RuntimeError('发布签名与安装包不一致')
    return envelope['kid']


def validate_release(source, root):
    """Everything a release must be before it reaches the feed: the CI manifest, its files, latest.yml
    for this installer, the release signature, and a version above the current feed. source is a work copy."""
    manifest_path = source / 'release-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    version = manifest['version']
    version_key(version)
    if (manifest['platform'], manifest['architecture'], manifest['gitWorkingTreeDirty']) != ('win32', 'x64', False) \
            or not isinstance(manifest['gitSha'], str) or not re.fullmatch(r'[a-f0-9]{40}', manifest['gitSha']):
        raise RuntimeError('构建来源信息不符')
    if manifest['summary']['checksFailed'] != 0 or not manifest['checks'] or not all(check['ok'] is True for check in manifest['checks']):
        raise RuntimeError('Windows 构建检查未全部通过')
    if not isinstance(manifest.get('releaseSignature'), dict):
        raise RuntimeError('未签名的候选包，只能用于安装验收')
    installer = f'Tuanbo-Link-Console-{version}-x64.exe'
    names = [installer, installer + '.blockmap', 'latest.yml']
    records = {}
    for name in names:
        matches = [item for item in manifest['artifacts'] if item['path'] == 'apps/desktop/dist/' + name]
        if len(matches) != 1:
            raise RuntimeError('manifest 中的产物记录不唯一')
        path = source / name
        if path.stat().st_size != matches[0]['bytes'] or digest(path).hexdigest() != matches[0]['sha256']:
            raise RuntimeError('产物与 manifest 不一致：' + name)
        records[name] = matches[0]
    metadata = feed_metadata((source / 'latest.yml').read_text())
    size = records[installer]['bytes']
    sha512 = base64.b64encode(digest(source / installer, 'sha512').digest()).decode()
    files = metadata.get('files')
    if metadata.get('version') != version or metadata.get('path') != installer or metadata.get('sha512') != sha512 \
            or not isinstance(files, list) or len(files) != 1 or files[0].get('url') != installer \
            or files[0].get('sha512') != sha512 or files[0].get('size') != size:
        raise RuntimeError('latest.yml 与安装包不一致')
    kid = verify_signature(metadata, installer, size, sha512, root)
    if kid != manifest['releaseSignature'].get('kid'):
        raise RuntimeError('发布签名与 manifest 记录不一致')
    current = current_feed(root)
    if current is not None and version_key(version) <= version_key(current['version']):
        raise RuntimeError(f'版本 {version} 不高于当前更新源（{current["version"]}）')
    return {'version': version, 'gitSha': manifest['gitSha'], 'manifestSha256': digest(manifest_path).hexdigest(),
            'releaseDate': metadata['releaseDate'], 'kid': kid, 'size': size, 'names': names, 'records': records,
            'signing': manifest['signing']}


def receipt_directory(root, kind, version):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    receipt = root / RECEIPTS / f'{stamp}-{kind}-{version}'
    receipt.mkdir(mode=0o700)
    return receipt


def archive_feed(root, keep, receipt):
    """The feed serves only the versions in keep: every other installer and blockmap moves into the receipt's
    archived folder, out of public reach. The feed and root's backups are separate mounts in the service unit, so
    each file is copied, checked and only then removed from the feed."""
    archived = []
    for path in sorted((root / FEED).iterdir()):
        match = VERSIONED.fullmatch(path.name)
        if not match or match.group(1) in keep:
            continue
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('更新目录里的文件不安全：' + path.name)
        target = receipt / 'archived' / path.name
        target.parent.mkdir(mode=0o700, exist_ok=True)
        shutil.copyfile(path, target)
        if digest(target).hexdigest() != digest(path).hexdigest():
            raise RuntimeError('移出更新源时复制校验失败：' + path.name)
        path.unlink()
        archived.append(path.name)
    return archived


def archived_versions(names):
    return sorted({VERSIONED.fullmatch(name).group(1) for name in names}, key=version_key)


def install(source, release, root, request=None):
    destination = root / FEED
    names = release['names']
    # Published versioned files must never be overwritten, including retries.
    if any((destination / name).exists() or (destination / name).is_symlink() for name in names[:2]):
        raise RuntimeError('该版本的安装包已发布过，不能覆盖')
    feed = destination / 'latest.yml'
    receipt = receipt_directory(root, 'update', release['version'])
    previous = feed.read_bytes() if feed.exists() else None
    if previous is not None:
        (receipt / 'previous-latest.yml').write_bytes(previous)
    shutil.copyfile(source / 'release-manifest.json', receipt / 'release-manifest.json')
    staged = []
    for name in names:
        pending = destination / ('.' + name + '.pending-' + uuid.uuid4().hex)
        with (source / name).open('rb') as incoming, pending.open('xb') as outgoing:
            os.chmod(pending, 0o644)
            shutil.copyfileobj(incoming, outgoing)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        if digest(pending).hexdigest() != release['records'][name]['sha256']:
            raise RuntimeError('写入后的文件校验失败')
        staged.append((pending, destination / name))
    # latest.yml is last in names: clients never see a feed whose installer is not in place.
    for pending, target in staged:
        os.replace(pending, target)
    # Keep this version and the one it replaced: a one-step rollback needs the previous installer, and clients
    # updating from it download its blockmap for the differential update.
    keep = {release['version']} | ({feed_metadata(previous.decode())['version']} if previous is not None else set())
    try:
        archived = archive_feed(root, keep, receipt)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(f'已发布 {release["version"]}，但移出旧版本失败：{error}') from None
    result = {'kind': 'publish', 'version': release['version'], 'gitSha': release['gitSha'], 'backup': str(receipt),
              'previousFeed': previous is not None, 'artifacts': release['records'], 'signing': release['signing'],
              'releaseSignature': release['kid'], 'archived': archived, 'request': request}
    (receipt / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


@contextmanager
def locked(root):
    with (root / PUBLISHER / 'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for leftover in (root / PUBLISHER / 'work').iterdir():  # a run that crashed mid-copy
            shutil.rmtree(leftover)
        yield


def publish(source, manifest_sha, git_sha, version, root=Path('/'), accounts=None):
    if not VERSION.fullmatch(version) or not re.fullmatch(r'[a-f0-9]{40}', git_sha):
        raise RuntimeError('版本号或提交号无效')
    accounts = accounts or system_accounts()
    check_layout(root, accounts)
    with locked(root):
        try:
            descriptor = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError:
            raise RuntimeError('发布目录缺失或是链接') from None
        try:
            with candidate(root, descriptor) as work:
                if digest(work / 'release-manifest.json').hexdigest() != manifest_sha:
                    raise RuntimeError('manifest 与审核过的不一致')
                release = validate_release(work, root)
                if (release['version'], release['gitSha']) != (version, git_sha):
                    raise RuntimeError('构建来源信息不符')
                return install(work, release, root)
        finally:
            os.close(descriptor)


def open_staged(staging_fd, name, accounts):
    if not isinstance(name, str) or not STAGED_NAME.fullmatch(name):
        raise RuntimeError('待发布版本名称无效')
    return open_owned_directory(name, accounts.builder, staging_fd)


def publish_staged(staging_fd, name, manifest_sha, root, accounts, request):
    """manifest_sha is the manifest the console confirmed, or None when the release goes live on its own."""
    entry = open_staged(staging_fd, name, accounts)
    try:
        with candidate(root, entry) as work:
            release = validate_release(work, root)
            if manifest_sha is None:
                if release['version'] != name.split('-')[0]:
                    raise RuntimeError('待发布目录名与版本不符')
                # A version that was on the feed before (a rollback withdrew it) only goes back by the owner's hand.
                if publish_receipt(root, release['version']) is not None:
                    raise RuntimeError(f'{release["version"]} 发布过，不再自动发布')
            # The console confirmed this exact manifest; a replaced staging entry is refused.
            elif release['manifestSha256'] != manifest_sha:
                raise RuntimeError('待发布版本的 manifest 与确认时不一致')
            result = install(work, release, root, request)
    finally:
        os.close(entry)
    try:
        shutil.rmtree(name, dir_fd=staging_fd)
    except OSError as error:
        raise RuntimeError(f'已发布 {result["version"]}，但未能删除待发布目录 {name}：{error}') from None
    return result


def publish_receipt(root, version):
    """The receipt of the publish that put this version on the feed; versioned files are published once."""
    for path in (root / RECEIPTS).glob(f'*-update-{version}'):
        receipt = path / 'receipt.json'
        if receipt.is_file() and json.loads(receipt.read_text()).get('version') == version:
            return path
    return None


def rollback_target(root):
    """The feed that the publish of the current version replaced, if it is signed and its installer is still
    in place and unchanged."""
    current = current_feed(root)
    receipt = None if current is None else publish_receipt(root, current['version'])
    if receipt is None or not (receipt / 'previous-latest.yml').is_file():
        return None, '没有可以回滚到的上一版'
    previous = feed_metadata((receipt / 'previous-latest.yml').read_text())
    if version_key(previous['version']) >= version_key(current['version']):
        return previous, '上一版不比当前版本旧'
    if 'tblinkRelease' not in previous:
        return previous, '上一版没有发布签名，不能从后台回滚'
    installer = root / FEED / previous['path']
    if previous.get('path') != f'Tuanbo-Link-Console-{previous["version"]}-x64.exe' or installer.is_symlink() or not installer.is_file():
        return previous, '上一版的安装包已不在更新目录'
    sha512 = base64.b64encode(digest(installer, 'sha512').digest()).decode()
    if previous.get('sha512') != sha512 or installer.stat().st_size != previous['files'][0].get('size'):
        return previous, '上一版的安装包与它的 latest.yml 不一致'
    try:
        verify_signature(previous, previous['path'], installer.stat().st_size, sha512, root)
    except RuntimeError as error:
        return previous, '上一版' + str(error)
    return previous, None


def rollback(version, root, request):
    previous, issue = rollback_target(root)
    if issue:
        raise RuntimeError(issue)
    if previous['version'] != version:
        raise RuntimeError('回滚目标与确认时不一致')
    receipt_source = publish_receipt(root, current_feed(root)['version'])
    feed = root / FEED / 'latest.yml'
    receipt = receipt_directory(root, 'rollback', version)
    (receipt / 'replaced-latest.yml').write_bytes(feed.read_bytes())
    pending = feed.with_name('.latest.yml.pending-' + uuid.uuid4().hex)
    with pending.open('xb') as outgoing:
        os.chmod(pending, 0o644)
        outgoing.write((receipt_source / 'previous-latest.yml').read_bytes())
        outgoing.flush()
        os.fsync(outgoing.fileno())
    os.replace(pending, feed)
    # The withdrawn version leaves the feed with anything else but the version now served.
    try:
        archived = archive_feed(root, {version}, receipt)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(f'更新源已回到 {version}，但移出撤下的版本失败：{error}') from None
    result = {'kind': 'rollback', 'version': version, 'backup': str(receipt), 'archived': archived, 'request': request}
    (receipt / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def discard(staging_fd, name, accounts):
    os.close(open_staged(staging_fd, name, accounts))
    shutil.rmtree(name, dir_fd=staging_fd)
    return {'kind': 'discard', 'name': name}


def write_json(path, value, accounts=None):
    """Atomically replaces path. With accounts the file is for the console: root's, readable by its group."""
    pending = path.with_name('.' + path.name + '.pending-' + uuid.uuid4().hex)
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        if accounts is not None:
            os.fchown(stream.fileno(), accounts.root, accounts.console_group)
            os.fchmod(stream.fileno(), 0o640)
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.replace(pending, path)


def status_source(root, staging_fd, accounts):
    """What the status depends on, read cheaply: every staged file's inode, size and change time, and the feed."""
    staged = []
    for name in sorted(os.listdir(staging_fd)):
        if not STAGED_NAME.fullmatch(name):
            continue
        try:
            entry = open_staged(staging_fd, name, accounts)
        except RuntimeError as error:  # The listing below reports it as this entry's issue.
            staged.append([name, str(error)])
            continue
        files = []
        try:
            for file in sorted(os.listdir(entry)):
                info = os.stat(file, dir_fd=entry, follow_symlinks=False)
                files.append([file, info.st_ino, info.st_size, info.st_ctime_ns])
        finally:
            os.close(entry)
        staged.append([name, files])
    feed = root / FEED / 'latest.yml'
    info = os.lstat(feed) if os.path.lexists(feed) else None
    return {'staged': staged, 'feed': None if info is None else [info.st_ino, info.st_size, info.st_ctime_ns]}


def refresh_status(root, accounts, force=True):
    """What the console shows: the feed, the version a rollback returns to, and each staged release.
    The timer runs this every 2 minutes; when no staged file or the feed changed, the last status stands
    instead of copying and hashing every staged installer again."""
    publisher = root / PUBLISHER
    staging_fd = open_owned_directory(root / STAGING, accounts.builder)
    try:
        source = status_source(root, staging_fd, accounts)
        cache = publisher / 'status-source.json'
        if not force and (publisher / 'update-status.json').exists() and cache.exists() and json.loads(cache.read_text()) == source:
            return
        staged = []
        for name, _files in source['staged']:
            entry = {'name': name, 'issue': None}
            try:
                descriptor = open_staged(staging_fd, name, accounts)
                try:
                    with candidate(root, descriptor) as work:
                        release = validate_release(work, root)
                finally:
                    os.close(descriptor)
                entry.update({key: release[key] for key in ('version', 'gitSha', 'manifestSha256', 'releaseDate', 'kid', 'size')})
            except Exception as error:  # Each staged entry reports its own failure; the listing continues.
                entry['issue'] = str(error)
            staged.append(entry)
    finally:
        os.close(staging_fd)
    current = current_feed(root)
    previous, issue = rollback_target(root)
    auto = json.loads((root / AUTO_PUBLISH).read_text()) if (root / AUTO_PUBLISH).exists() else None
    write_json(publisher / 'update-status.json', {
        'version': 1, 'generatedAt': now(),
        'feed': None if current is None else {'version': current['version'], 'releaseDate': current['releaseDate'], 'signed': 'tblinkRelease' in current},
        'rollback': {'version': None if previous is None else previous['version'], 'issue': issue},
        'staged': staged,
        'autoPublish': None if auto is None else {key: auto[key] for key in ('name', 'ok', 'message', 'at')}}, accounts)
    write_json(cache, source)


REQUEST_FIELDS = {
    'publish': {'id', 'action', 'staged', 'manifestSha256', 'actor', 'reason', 'requestedAt'},
    'rollback': {'id', 'action', 'version', 'actor', 'reason', 'requestedAt'},
    'discard': {'id', 'action', 'staged', 'actor', 'reason', 'requestedAt'},
}
MAX_REQUEST = 16384


def text_field(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and not any(ord(char) < 32 for char in value)


def read_request(requests_fd, request_id, owner_uid):
    """A request written by the console's service account. Opened without following links and without
    blocking on a FIFO; only a small regular file owned by that account, with exactly the expected fields."""
    try:
        descriptor = os.open(request_id + '.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=requests_fd)
    except OSError:
        raise RuntimeError('请求文件无效') from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_size > MAX_REQUEST:
            raise RuntimeError('请求文件无效')
        data = os.read(descriptor, MAX_REQUEST + 1)
    finally:
        os.close(descriptor)
    try:
        request = json.loads(data)
    except ValueError:
        raise RuntimeError('请求内容无效') from None
    if not isinstance(request, dict) or request.get('action') not in REQUEST_FIELDS or set(request) != REQUEST_FIELDS[request['action']]:
        raise RuntimeError('请求内容无效')
    if request['id'] != request_id or not text_field(request['actor'], 200) or not text_field(request['reason'], 500) \
            or not isinstance(request['requestedAt'], str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z', request['requestedAt']) \
            or 'staged' in request and not (isinstance(request['staged'], str) and STAGED_NAME.fullmatch(request['staged'])) \
            or 'manifestSha256' in request and not (isinstance(request['manifestSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', request['manifestSha256'])) \
            or 'version' in request and not (isinstance(request['version'], str) and VERSION.fullmatch(request['version'])):
        raise RuntimeError('请求内容无效')
    return request


def handle(request, root, accounts):
    actor = {'actor': request['actor'], 'reason': request['reason'], 'id': request['id'], 'requestedAt': request['requestedAt']}
    if request['action'] == 'rollback':
        result = rollback(request['version'], root, actor)
        moved = archived_versions(result['archived'])
        return result['version'], f'更新源已回到 {result["version"]}' + (f'，已移出更新源：{"、".join(moved)}' if moved else '')
    staging_fd = open_owned_directory(root / STAGING, accounts.builder)
    try:
        if request['action'] == 'publish':
            result = publish_staged(staging_fd, request['staged'], request['manifestSha256'], root, accounts, actor)
            moved = archived_versions(result['archived'])
            return result['version'], f'已发布 {result["version"]}' + (f'，已移出更新源：{"、".join(moved)}' if moved else '')
        discard(staging_fd, request['staged'], accounts)
        return request['staged'].split('-')[0], f'已丢弃待发布版本 {request["staged"]}'
    finally:
        os.close(staging_fd)


AUTO_PUBLISH = PUBLISHER + '/auto-publish.json'
AUTO_ACTOR = 'release-builder（自动发布）'


def auto_publish(root, accounts):
    """Puts the highest staged version above the feed on the feed, once per upload: the attempt is recorded with
    the staged files' fingerprint, so a failure is not tried again until the builder uploads anew. Lower versions
    and versions that were on the feed before stay staged for the owner. Returns whether it tried."""
    record_path = root / AUTO_PUBLISH
    last = json.loads(record_path.read_text()) if record_path.exists() else None
    current = current_feed(root)
    staging_fd = open_owned_directory(root / STAGING, accounts.builder)
    try:
        candidates = [(name, files) for name, files in status_source(root, staging_fd, accounts)['staged']
                      if (current is None or version_key(name.split('-')[0]) > version_key(current['version']))
                      and publish_receipt(root, name.split('-')[0]) is None]
        if not candidates:
            return False
        name, fingerprint = max(candidates, key=lambda item: version_key(item[0].split('-')[0]))
        if last is not None and [last['name'], last['fingerprint']] == [name, fingerprint]:
            return False
        try:
            result = publish_staged(staging_fd, name, None, root, accounts, {'actor': AUTO_ACTOR, 'staged': name})
            moved = archived_versions(result['archived'])
            version, ok = result['version'], True
            message = f'已自动发布 {version}' + (f'，已移出更新源：{"、".join(moved)}' if moved else '')
        except Exception as error:  # Recorded and shown in the console; tried again only for a new upload.
            version, ok, message = None, False, f'{name} 没有自动发布：{error}'
    finally:
        os.close(staging_fd)
    at = now()
    write_json(record_path, {'name': name, 'fingerprint': fingerprint, 'ok': ok, 'message': message, 'at': at})
    with (root / AUDIT).open('a') as audit:
        audit.write(json.dumps({'id': name, 'requestedAt': None, 'processedAt': at, 'actor': AUTO_ACTOR, 'action': 'auto-publish',
                                'version': version, 'ok': ok, 'message': message}, ensure_ascii=False) + '\n')
    return True


def process_requests(root=Path('/'), accounts=None):
    """Runs each request once, oldest first, then publishes a newly staged release. The request directory belongs
    to the console's service account; this script only reads it, and the console removes a request once it has
    read the result. A request with a result already is a duplicate and is left alone."""
    accounts = accounts or system_accounts()
    check_layout(root, accounts)
    publisher = root / PUBLISHER
    with locked(root):
        requests_fd = open_owned_directory(root / REQUESTS, accounts.console)
        handled = False
        try:
            while True:
                pending = sorted(name[:-5] for name in os.listdir(requests_fd) if name.endswith('.json') and REQUEST_ID.fullmatch(name[:-5])
                                 and not (publisher / 'results' / name).exists())
                if not pending:
                    break
                for request_id in pending:
                    handled = True
                    request = None
                    try:
                        request = read_request(requests_fd, request_id, accounts.console)
                        version, message = handle(request, root, accounts)
                        result = {'id': request_id, 'ok': True, 'message': message, 'at': now()}
                    except Exception as error:  # Reported to the console and the audit log; never retried automatically.
                        version = None
                        result = {'id': request_id, 'ok': False, 'message': str(error), 'at': now()}
                    write_json(publisher / 'results' / (request_id + '.json'), result, accounts)
                    with (root / AUDIT).open('a') as audit:
                        audit.write(json.dumps({'id': request_id, 'requestedAt': None if request is None else request['requestedAt'],
                                                'processedAt': result['at'], 'actor': None if request is None else request['actor'],
                                                'action': None if request is None else request['action'], 'version': version,
                                                'ok': result['ok'], 'message': result['message']}, ensure_ascii=False) + '\n')
        finally:
            os.close(requests_fd)
        attempted = auto_publish(root, accounts)
        refresh_status(root, accounts, force=handled or attempted)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--process-requests', action='store_true')
    parser.add_argument('arguments', nargs='*')
    args = parser.parse_args()
    if args.process_requests:
        if args.arguments:
            parser.error('--process-requests takes no arguments')
        process_requests()
    elif len(args.arguments) == 4:
        directory, manifest_sha, git_sha, version = args.arguments
        print(json.dumps(publish(Path(directory), manifest_sha, git_sha, version)))
    else:
        parser.error('expected <directory> <manifest_sha256> <git_sha> <version>, or --process-requests')
