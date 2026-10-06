"""Offline restore drill only; never writes to a running production database."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import subprocess
import tarfile
import tempfile


def verify(archive, identity):
    with tempfile.TemporaryDirectory(prefix='tblink-restore-') as directory:
        root = Path(directory)
        subprocess.run(['age', '--decrypt', '-i', str(identity), '-o', str(root / 'backup.tar'), str(archive)], check=True, capture_output=True, timeout=300)
        with tarfile.open(root / 'backup.tar', 'r:') as tar:
            names = set()
            for member in tar.getmembers():
                path = PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or '..' in path.parts or member.name in names or member.size > 2_000_000_000:
                    raise RuntimeError('Invalid restore member')
                if member.name not in {'manifest.json', 'license.db', 'delivery-recovery.db'} and (len(path.parts) != 2 or path.parts[0] != 'keys'):
                    raise RuntimeError('Unexpected restore member')
                names.add(member.name)
                target = root / member.name
                target.parent.mkdir(mode=0o700, exist_ok=True)
                with tar.extractfile(member) as source, target.open('xb') as output:
                    import shutil
                    shutil.copyfileobj(source, output)
        manifest = json.loads((root / 'manifest.json').read_text())
        if manifest['version'] != 1 or set(manifest['files']) != names - {'manifest.json'}:
            raise RuntimeError('Restore manifest mismatch')
        for name, digest in manifest['files'].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError('Restore digest mismatch')
        with closing(sqlite3.connect(root / 'license.db')) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
                raise RuntimeError('Restored database integrity failure')
            counts = {name: db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in ['orders', 'licenses', 'payment_receipts', 'console_users', 'console_audit']}
        return {'status': 'success', 'counts': counts, 'productionModified': False}


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--identity', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.identity)))
