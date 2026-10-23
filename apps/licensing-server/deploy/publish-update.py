#!/usr/bin/env python3
"""Publish verified Windows releases; install immutable assets before replacing the feed.

Usage (root):
  publish-update.py <directory> <manifest_sha256> <git_sha> <version>   publish a reviewed directory by hand
  publish-update.py --process-requests                                    run the console's queued requests
The console never writes the feed. It queues a request; this script, started as root by
tblink-update-publish.path, re-validates everything and writes the result back.
"""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import uuid

import yaml
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key

FEED = 'srv/tblink-updates/windows/x64'
STAGING = 'var/lib/tblink-release/staging'
SPOOL = 'var/lib/tblink-licensing/update-release'
BACKUPS = 'var/lib/tblink-licensing/backups'
KEYS = 'opt/tblink-licensing/release-public-keys.json'
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
STAGED_NAME = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-[a-f0-9]{12}')
REQUEST_ID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
# The licensing service account writes requests from the console; nothing else may.
REQUEST_OWNER = 'tblink-license'


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
    for this installer, the release signature, and a version above the current feed."""
    manifest_path = source / 'release-manifest.json'
    if manifest_path.is_symlink():
        raise RuntimeError('manifest 不能是链接')
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
        if path.is_symlink() or path.stat().st_size != matches[0]['bytes'] or digest(path).hexdigest() != matches[0]['sha256']:
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
    receipt = root / BACKUPS / f'{stamp}-{kind}-{version}'
    receipt.mkdir(mode=0o700)
    return receipt


def install(source, release, root, request=None):
    destination = root / FEED
    if not destination.is_dir() or destination.is_symlink():
        raise RuntimeError('更新目录缺失或不安全')
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
    result = {'kind': 'publish', 'version': release['version'], 'gitSha': release['gitSha'], 'backup': str(receipt),
              'previousFeed': previous is not None, 'artifacts': release['records'], 'signing': release['signing'],
              'releaseSignature': release['kid'], 'request': request}
    (receipt / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def publish(source, manifest_sha, git_sha, version, root=Path('/')):
    if not VERSION.fullmatch(version) or not re.fullmatch(r'[a-f0-9]{40}', git_sha):
        raise RuntimeError('版本号或提交号无效')
    if digest(source / 'release-manifest.json').hexdigest() != manifest_sha:
        raise RuntimeError('manifest 与审核过的不一致')
    release = validate_release(source, root)
    if (release['version'], release['gitSha']) != (version, git_sha):
        raise RuntimeError('构建来源信息不符')
    return install(source, release, root)


def staged_path(root, name):
    if not isinstance(name, str) or not STAGED_NAME.fullmatch(name):
        raise RuntimeError('待发布版本名称无效')
    path = root / STAGING / name
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError('找不到待发布版本')
    return path


def publish_staged(name, manifest_sha, root, request):
    source = staged_path(root, name)
    release = validate_release(source, root)
    # The console confirmed this exact manifest; a replaced staging entry is refused.
    if release['manifestSha256'] != manifest_sha:
        raise RuntimeError('待发布版本的 manifest 与确认时不一致')
    result = install(source, release, root, request)
    shutil.rmtree(source)
    return result


def publish_receipt(root, version):
    """The receipt of the publish that put this version on the feed; versioned files are published once."""
    for path in (root / BACKUPS).glob(f'*-update-{version}'):
        receipt = path / 'receipt.json'
        if receipt.is_file() and json.loads(receipt.read_text()).get('version') == version:
            return path
    return None


def rollback_target(root):
    """The feed that the publish of the current version replaced, if its installer is still in place and unchanged."""
    current = current_feed(root)
    receipt = None if current is None else publish_receipt(root, current['version'])
    if receipt is None or not (receipt / 'previous-latest.yml').is_file():
        return None, '没有可以回滚到的上一版'
    previous_text = (receipt / 'previous-latest.yml').read_text()
    previous = feed_metadata(previous_text)
    if version_key(previous['version']) >= version_key(current['version']):
        return previous, '上一版不比当前版本旧'
    installer = root / FEED / previous['path']
    if previous.get('path') != f'Tuanbo-Link-Console-{previous["version"]}-x64.exe' or installer.is_symlink() or not installer.is_file():
        return previous, '上一版的安装包已不在更新目录'
    sha512 = base64.b64encode(digest(installer, 'sha512').digest()).decode()
    if previous.get('sha512') != sha512 or installer.stat().st_size != previous['files'][0].get('size'):
        return previous, '上一版的安装包与它的 latest.yml 不一致'
    if 'tblinkRelease' in previous:
        verify_signature(previous, previous['path'], installer.stat().st_size, sha512, root)
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
    result = {'kind': 'rollback', 'version': version, 'backup': str(receipt), 'request': request}
    (receipt / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def discard(name, root):
    shutil.rmtree(staged_path(root, name))
    return {'kind': 'discard', 'name': name}


def write_json(path, value):
    pending = path.with_name('.' + path.name + '.pending-' + uuid.uuid4().hex)
    with pending.open('x') as stream:
        os.chmod(pending, 0o644)
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.replace(pending, path)


def refresh_status(root):
    """What the console shows: the feed, the version a rollback returns to, and each staged release."""
    staged = []
    staging = root / STAGING
    for path in sorted(staging.iterdir()) if staging.is_dir() else []:
        if path.is_symlink() or not path.is_dir() or not STAGED_NAME.fullmatch(path.name):
            continue
        entry = {'name': path.name, 'issue': None}
        try:
            release = validate_release(path, root)
            entry.update({key: release[key] for key in ('version', 'gitSha', 'manifestSha256', 'releaseDate', 'kid', 'size')})
        except Exception as error:  # Each staged entry reports its own failure; the listing continues.
            entry['issue'] = str(error)
        staged.append(entry)
    current = current_feed(root)
    previous, issue = rollback_target(root)
    write_json(root / SPOOL / 'update-status.json', {
        'version': 1, 'generatedAt': now(),
        'feed': None if current is None else {'version': current['version'], 'releaseDate': current['releaseDate'], 'signed': 'tblinkRelease' in current},
        'rollback': {'version': None if previous is None else previous['version'], 'issue': issue},
        'staged': staged})


REQUEST_FIELDS = {
    'publish': {'id', 'action', 'staged', 'manifestSha256', 'actor', 'reason', 'requestedAt'},
    'rollback': {'id', 'action', 'version', 'actor', 'reason', 'requestedAt'},
    'discard': {'id', 'action', 'staged', 'actor', 'reason', 'requestedAt'},
}
MAX_REQUEST = 16384


def text_field(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and not any(ord(char) < 32 for char in value)


def read_request(path, request_id, owner_uid):
    """A request written by the console's service account. Opened without following links and without
    blocking on a FIFO; only a small regular file owned by that account, with exactly the expected fields."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
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


def handle(request, root):
    actor = {'actor': request['actor'], 'reason': request['reason'], 'id': request['id'], 'requestedAt': request['requestedAt']}
    if request['action'] == 'publish':
        result = publish_staged(request['staged'], request['manifestSha256'], root, actor)
        return result['version'], f'已发布 {result["version"]}'
    if request['action'] == 'rollback':
        result = rollback(request['version'], root, actor)
        return result['version'], f'更新源已回到 {result["version"]}'
    discard(request['staged'], root)
    return request['staged'].split('-')[0], f'已丢弃待发布版本 {request["staged"]}'


def process_requests(root=Path('/'), owner_uid=None):
    """Runs each request once, oldest first. The request directory belongs to the console's service account;
    this script only reads it. A request with a result already is a duplicate and is left alone."""
    if owner_uid is None:
        owner_uid = pwd.getpwnam(REQUEST_OWNER).pw_uid
    spool = root / SPOOL
    with (spool / 'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        while True:
            pending = [path for path in sorted((spool / 'update-requests').glob('*.json'), key=lambda item: item.name)
                       if REQUEST_ID.fullmatch(path.stem) and not (spool / 'update-results' / path.name).exists()]
            if not pending:
                break
            for path in pending:
                request_id = path.stem
                request = None
                try:
                    request = read_request(path, request_id, owner_uid)
                    version, message = handle(request, root)
                    result = {'id': request_id, 'ok': True, 'message': message, 'at': now()}
                except Exception as error:  # Reported to the console and the audit log; never retried automatically.
                    version = None
                    result = {'id': request_id, 'ok': False, 'message': str(error), 'at': now()}
                write_json(spool / 'update-results' / (request_id + '.json'), result)
                with (root / BACKUPS / 'update-audit.jsonl').open('a') as audit:
                    audit.write(json.dumps({'id': request_id, 'requestedAt': None if request is None else request['requestedAt'],
                                            'processedAt': result['at'], 'actor': None if request is None else request['actor'],
                                            'action': None if request is None else request['action'], 'version': version,
                                            'ok': result['ok'], 'message': result['message']}, ensure_ascii=False) + '\n')
        refresh_status(root)


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
