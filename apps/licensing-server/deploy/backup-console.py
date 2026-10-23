"""Consistent SQLite + service-key backup, age encryption, verified offsite copy."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import uuid

# The recipient and the local encrypted copies are root's. The licensing account owns /etc/tblink-licensing and
# /var/lib/tblink-licensing and could otherwise swap in its own age recipient or point the copies elsewhere.
CONFIG = Path('/etc/tblink-backup/backup.json')
DATABASE = Path('/var/lib/tblink-licensing/license.db')
KEYS = Path('/etc/tblink-licensing')
BACKUPS = Path('/var/backups/tblink')
LOCAL = BACKUPS / 'console'
TRUSTED = Path('/')
ROOT_UID = 0
NAME = re.compile(r'console-(\d{8}T\d{6}Z)-[a-f0-9]{32}\.tar\.age')


def require_root_only(path):
    """path and every directory above it are root's and writable by no one else; path is a directory or a file."""
    current = TRUSTED
    for part in ('', *path.relative_to(TRUSTED).parts):
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            raise RuntimeError(f'Missing: {current}') from None
        kind = stat.S_ISDIR(info.st_mode) or current == path and stat.S_ISREG(info.st_mode)
        if not kind or info.st_uid != ROOT_UID or info.st_mode & 0o022:
            raise RuntimeError(f'Must be root-only: {current}')


def read_config():
    require_root_only(CONFIG)
    return json.loads(CONFIG.read_text())


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def snapshot(source, target):
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as db, closing(sqlite3.connect(target)) as out:
        db.backup(out)
        if out.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or out.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('SQLite backup integrity check failed')
    target.chmod(0o600)


def health(state, detail):
    with closing(sqlite3.connect(DATABASE, timeout=5)) as db, db:
        db.execute('INSERT INTO console_health VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,detail=excluded.detail',
                   ('backup', state, datetime.now(timezone.utc).isoformat(), detail))
        if state == 'success':
            db.execute('INSERT INTO console_health VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,detail=excluded.detail',
                       ('backup-last-success', state, datetime.now(timezone.utc).isoformat(), detail))


def prune(directory, now):
    root = directory.resolve()
    for file in directory.iterdir():
        match = NAME.fullmatch(file.name)
        if not match or file.is_symlink() or not file.is_file() or file.resolve().parent != root:
            continue
        created = datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
        if created < now - timedelta(days=30):
            file.unlink()


def backup(config):
    recipient = config['ageRecipient']
    if not isinstance(recipient, str) or not re.fullmatch('age1[a-z0-9]{58}', recipient):
        raise RuntimeError('An offline age public recipient is required')
    mount = Path(config['offsiteMount'])
    offsite = Path(config['offsiteDirectory'])
    if not mount.is_absolute() or not offsite.is_absolute() or not os.path.ismount(mount) or not offsite.resolve().is_relative_to(mount.resolve()):
        raise RuntimeError('Offsite target must be inside an explicitly mounted volume')
    require_root_only(BACKUPS)
    LOCAL.mkdir(mode=0o700, exist_ok=True)
    require_root_only(LOCAL)
    if mount.stat().st_dev == LOCAL.stat().st_dev:
        raise RuntimeError('Offsite target cannot use the local filesystem')
    offsite.mkdir(mode=0o700, parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    name = 'console-' + now.strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex + '.tar.age'
    with tempfile.TemporaryDirectory(prefix='tblink-backup-', dir=LOCAL) as folder:
        stage = Path(folder)
        snapshot(DATABASE, stage / 'license.db')
        snapshot(stage / 'license.db', stage / 'restore-check.db')
        # Compare logical data, not page layout changed by SQLite's backup API.
        with closing(sqlite3.connect(stage / 'license.db')) as original, closing(sqlite3.connect(stage / 'restore-check.db')) as restored:
            if list(original.iterdump()) != list(restored.iterdump()):
                raise RuntimeError('Backup restore verification failed')
        key_files = [path for path in KEYS.iterdir() if path.is_file()]
        if any(path.is_symlink() for path in key_files):
            raise RuntimeError('Key directory cannot contain symlinked files')
        files = {'license.db': stage / 'license.db'}
        for source in key_files:
            target = stage / ('key-' + source.name)
            shutil.copyfile(source, target)
            target.chmod(0o600)
            files['keys/' + source.name] = target
        recovery = DATABASE.with_name('delivery-recovery.db')
        if recovery.exists():
            snapshot(recovery, stage / 'delivery-recovery.db')
            files['delivery-recovery.db'] = stage / 'delivery-recovery.db'
        manifest = {'version': 1, 'created': now.isoformat(), 'files': {key: digest(path) for key, path in files.items()}}
        (stage / 'manifest.json').write_text(json.dumps(manifest))
        with tarfile.open(stage / 'backup.tar', 'w') as archive:
            for key, path in files.items():
                archive.add(path, arcname=key, recursive=False)
            archive.add(stage / 'manifest.json', arcname='manifest.json', recursive=False)
        subprocess.run(['age', '-r', recipient, '-o', str(stage / name), str(stage / 'backup.tar')], check=True, capture_output=True, timeout=300)
        os.replace(stage / name, LOCAL / name)
    (LOCAL / name).chmod(0o600)
    remote = offsite / name
    with (LOCAL / name).open('rb') as source, remote.open('xb') as target:
        shutil.copyfileobj(source, target)
        target.flush()
        os.fsync(target.fileno())
    remote.chmod(0o600)
    if digest(remote) != digest(LOCAL / name):
        raise RuntimeError('Offsite encrypted copy digest mismatch')
    prune(LOCAL, now)
    prune(offsite, now)
    return name


def main():
    os.umask(0o077)
    try:
        result = backup(read_config())
        health('success', '加密备份与异地副本摘要核对成功；本地 SQLite 恢复核验通过')
        print(json.dumps({'status': 'success', 'backup': result}))
    except Exception as error:
        health('failed', '备份失败，请检查受限运维日志：' + type(error).__name__)
        raise


if __name__ == '__main__':
    main()
