"""Offline restore drill only; never writes to a running production database."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import sqlite3
import subprocess
import tarfile
import tempfile


def restore_path(name):
    path = PurePosixPath(name)
    if (path.is_absolute() or '..' in path.parts or path.as_posix() != name
            or any('\\' in part or ':' in part or part.rstrip(' .') != part
                   or PureWindowsPath(part).is_reserved() or any(ord(char) < 32 for char in part)
                   for part in path.parts)):
        raise RuntimeError('Invalid restore member path')
    if name not in {'manifest.json', 'license.db', 'delivery-recovery.db'} and (len(path.parts) != 2 or path.parts[0] != 'keys'):
        raise RuntimeError('Unexpected restore member')
    return path


def verify(archive, identity):
    with tempfile.TemporaryDirectory(prefix='tblink-restore-') as directory:
        root = Path(directory)
        subprocess.run(['age', '--decrypt', '-i', str(identity), '-o', str(root / 'backup.tar'), str(archive)], check=True, capture_output=True, timeout=300)
        with tarfile.open(root / 'backup.tar', 'r:') as tar:
            names = set()
            for member in tar.getmembers():
                path = restore_path(member.name)
                if not member.isfile() or member.name in names or member.size > 2_000_000_000:
                    raise RuntimeError('Invalid restore member')
                names.add(member.name)
                target = root.joinpath(*path.parts)
                target.parent.mkdir(mode=0o700, exist_ok=True)
                with tar.extractfile(member) as source, target.open('xb') as output:
                    import shutil
                    shutil.copyfileobj(source, output)
        manifest = json.loads((root / 'manifest.json').read_text())
        if manifest['version'] != 1 or 'license.db' not in names or set(manifest['files']) != names - {'manifest.json'}:
            raise RuntimeError('Restore manifest mismatch')
        for name, digest in manifest['files'].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError('Restore digest mismatch')
        counts = {}
        for name in ['license.db', 'delivery-recovery.db']:
            if name not in names:
                continue
            with closing(sqlite3.connect((root / name).resolve().as_uri() + '?mode=ro', uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
                    raise RuntimeError('Restored database integrity failure: ' + name)
                if name == 'license.db':
                    counts = {table: db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in ['orders', 'licenses', 'payment_receipts', 'console_users', 'console_audit']}
        return {'status': 'success', 'counts': counts, 'productionModified': False}


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--identity', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.identity)))
