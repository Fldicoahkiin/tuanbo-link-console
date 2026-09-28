#!/usr/bin/env python3
"""Publish verified Windows files; install immutable assets before replacing the feed."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import uuid


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def publish(source, manifest_sha, git_sha, version, root=Path('/')):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) or not re.fullmatch(r'[a-f0-9]{40}', git_sha):
        raise RuntimeError('Invalid version or commit')
    manifest_path = source / 'release-manifest.json'
    if digest(manifest_path) != manifest_sha:
        raise RuntimeError('Release manifest differs from reviewed artifact')
    manifest = json.loads(manifest_path.read_text())
    if (manifest['version'], manifest['gitSha'], manifest['platform'], manifest['architecture'], manifest['gitWorkingTreeDirty']) != (version, git_sha, 'win32', 'x64', False):
        raise RuntimeError('Release provenance differs')
    if manifest['summary']['checksFailed'] != 0 or not manifest['checks'] or not all(check['ok'] is True for check in manifest['checks']):
        raise RuntimeError('Windows release checks failed')
    installer = f'Tuanbo-Link-Console-{version}-x64.exe'
    names = [installer, installer + '.blockmap', 'latest.yml']
    records = {}
    for name in names:
        matches = [item for item in manifest['artifacts'] if item['path'] == 'apps/desktop/dist/' + name]
        if len(matches) != 1:
            raise RuntimeError('Expected exactly one release artifact')
        record = matches[0]
        path = source / name
        if path.is_symlink() or path.stat().st_size != record['bytes'] or digest(path) != record['sha256']:
            raise RuntimeError('Release artifact differs: ' + name)
        records[name] = record
    destination = root / 'srv/tblink-updates/windows/x64'
    if not destination.is_dir() or destination.is_symlink():
        raise RuntimeError('Update directory is missing or unsafe')
    # Published versioned files must never be overwritten, including retries.
    if any((destination / name).exists() or (destination / name).is_symlink() for name in names[:2]):
        raise RuntimeError('Versioned update files already exist')
    feed = destination / 'latest.yml'
    if feed.is_symlink():
        raise RuntimeError('Unexpected feed symlink')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    receipt = root / 'var/lib/tblink-licensing/backups' / (stamp + '-update-' + version)
    receipt.mkdir(mode=0o700)
    previous = feed.read_bytes() if feed.exists() else None
    if previous is not None:
        (receipt / 'previous-latest.yml').write_bytes(previous)
    shutil.copyfile(manifest_path, receipt / 'release-manifest.json')
    staged = []
    for name in names:
        target = destination / name
        pending = destination / ('.' + name + '.pending-' + uuid.uuid4().hex)
        with (source / name).open('rb') as incoming, pending.open('xb') as outgoing:
            os.chmod(pending, 0o644)
            shutil.copyfileobj(incoming, outgoing)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        if digest(pending) != records[name]['sha256']:
            raise RuntimeError('Staged file failed verification')
        staged.append((pending, target))
    for pending, target in staged:
        os.replace(pending, target)
    result = {'version': version, 'gitSha': git_sha, 'backup': str(receipt),
              'previousFeed': previous is not None, 'artifacts': records,
              'signing': manifest['signing']}
    (receipt / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('manifest_sha256')
    parser.add_argument('git_sha')
    parser.add_argument('version')
    args = parser.parse_args()
    print(json.dumps(publish(args.directory, args.manifest_sha256, args.git_sha, args.version)))
