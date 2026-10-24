#!/usr/bin/env python3
"""Restricted SSH receiver for Windows releases, used by the release relay (scripts/relay-release.mjs).

Runs as tblink-release through ForceCommand, without sudo. Without a command it reads one uncompressed tar on
stdin (release-manifest.json, latest.yml, the installer and its blockmap), checks the files against the manifest
and writes them to a new staging entry. With the command `status` it only reports the staged entries and whether
an upload is running, so a relay never sends a release the server already has. One upload at a time: a second one
is refused at once. It never touches the feed: publish-update.py validates the entry again, signature included.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tarfile
import uuid

STAGING = Path('/var/lib/tblink-release/staging')
STAGED_NAME = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-[a-f0-9]{12}')
LOCK = '.upload.lock'
MAX_UPLOAD = 2 * 1024 ** 3
MAX_STAGED = 5
# Uploads come from the domestic build machine; a stalled connection must not hold the slot for good.
UPLOAD_SECONDS = 3600


def upload_lock(staging):
    """The upload slot, held for as long as the returned descriptor is open, or None while another upload holds it.
    Opened read-only, so taking it does not count as a change to the staging directory."""
    descriptor = os.open(staging / LOCK, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o640)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        return None
    return descriptor


def status(staging=STAGING):
    """What a relay checks before uploading: the complete staged entries and whether an upload is running."""
    lock = upload_lock(staging)
    if lock is not None:
        os.close(lock)
    return {'staged': sorted(path.name for path in staging.iterdir() if STAGED_NAME.fullmatch(path.name)), 'uploading': lock is None}


def receive(stream, staging=STAGING):
    staged = [path for path in staging.iterdir() if not path.name.startswith('.')]
    if len(staged) >= MAX_STAGED:
        raise RuntimeError('Too many staged releases: publish or discard them in the console first')
    incoming = staging / ('.incoming-' + uuid.uuid4().hex)
    incoming.mkdir(mode=0o750)
    try:
        archive_path = incoming / '.upload.tar'
        total = 0
        with archive_path.open('xb') as output:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                total += len(chunk)
                if total > MAX_UPLOAD:
                    raise RuntimeError('Upload exceeds limit')
                output.write(chunk)
        with tarfile.open(archive_path, mode='r:') as archive:
            members = archive.getmembers()
            names = [member.name for member in members]
            if len(set(names)) != len(names) or 'release-manifest.json' not in names or not all(member.isfile() for member in members):
                raise RuntimeError('Unexpected upload files')
            manifest_member = archive.getmember('release-manifest.json')
            if manifest_member.size > 1024 * 1024:
                raise RuntimeError('Manifest too large')
            with archive.extractfile(manifest_member) as source:
                manifest_bytes = source.read()
            manifest = json.loads(manifest_bytes)
            version, git_sha = manifest.get('version'), manifest.get('gitSha')
            if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version) \
                    or not isinstance(git_sha, str) or not re.fullmatch(r'[a-f0-9]{40}', git_sha):
                raise RuntimeError('Invalid release identity')
            if (manifest.get('platform'), manifest.get('architecture'), manifest.get('gitWorkingTreeDirty')) != ('win32', 'x64', False) \
                    or manifest.get('summary', {}).get('checksFailed') != 0 or not isinstance(manifest.get('releaseSignature'), dict):
                raise RuntimeError('Not a signed, fully checked release build')
            installer = f'Tuanbo-Link-Console-{version}-x64.exe'
            expected = {'release-manifest.json', 'latest.yml', installer, installer + '.blockmap'}
            if set(names) != expected:
                raise RuntimeError('Unexpected upload files')
            records = {item['path']: item for item in manifest['artifacts']}
            for member in members:
                if member.name == 'release-manifest.json':
                    continue
                record = records.get('apps/desktop/dist/' + member.name)
                if record is None or member.size != record['bytes']:
                    raise RuntimeError('Upload differs from manifest: ' + member.name)
                digest = hashlib.sha256()
                with archive.extractfile(member) as source, (incoming / member.name).open('xb') as target:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk)
                        target.write(chunk)
                if digest.hexdigest() != record['sha256']:
                    raise RuntimeError('Upload differs from manifest: ' + member.name)
            (incoming / 'release-manifest.json').write_bytes(manifest_bytes)
        archive_path.unlink()
        for path in incoming.iterdir():
            os.chmod(path, 0o640)
        final = staging / f'{version}-{git_sha[:12]}'
        if final.exists():
            raise RuntimeError('Release already staged')
        # The rename is what tblink-update-publish.path watches for.
        os.rename(incoming, final)
        return {'staged': final.name, 'version': version, 'gitSha': git_sha, 'bytes': total,
                'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest()}
    except BaseException:
        shutil.rmtree(incoming, ignore_errors=True)
        raise


def timeout(_signal, _frame):
    raise TimeoutError('Upload timed out')


if __name__ == '__main__':
    os.umask(0o027)
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(UPLOAD_SECONDS)
    try:
        command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
        if command == 'status':
            print(json.dumps(status()))
            sys.exit(0)
        if command:
            raise RuntimeError('Unknown command')
        lock = upload_lock(STAGING)
        if lock is None:
            raise RuntimeError('Another upload is in progress')
        print(json.dumps(receive(sys.stdin.buffer)))
    except Exception as error:  # The relay reads this line; nothing is staged.
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
