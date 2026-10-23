#!/usr/bin/env python3
"""Enable an approved first-sale catalog, preserving environment data and rolling back on failed health checks."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import stat as file_mode
import subprocess
import time
import urllib.error
import urllib.request
import uuid

# Root's backups, below root: never inside a service account's directory, whose owner could swap them.
BACKUPS = 'var/backups/tblink'
ROOT_UID = 0


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sales_environment(raw):
    text = raw.decode('utf-8')
    settings = {}
    for line in text.splitlines():
        value = line.strip()
        if not value or value.startswith('#'):
            continue
        if '=' not in value:
            raise RuntimeError('Unexpected environment syntax')
        name, value = value.split('=', 1)
        if name in settings:
            raise RuntimeError('Duplicate environment setting')
        parsed = shlex.split(value, comments=True)
        if len(parsed) != 1:
            raise RuntimeError('Ambiguous environment value')
        settings[name] = parsed[0]
    if settings.get('ALIPAY_CHECKOUT_ENABLED') != 'false' or settings.get('LICENSE_CATALOG_FILE'):
        raise RuntimeError('Expected closed sales without a catalog')
    if settings.get('ALIPAY_APP_ID') != '2021007101657826' or settings.get('ALIPAY_SELLER_ID') != '2088980148916563':
        raise RuntimeError('Company payment identity differs')
    for name in ('ALIPAY_PRIVATE_KEY_FILE', 'ALIPAY_PUBLIC_KEY_FILE'):
        if not settings.get(name):
            raise RuntimeError('Payment key path is missing')
    changed, count = re.subn(r'^(ALIPAY_CHECKOUT_ENABLED\s*=\s*)(?:false|\"false\"|\x27false\x27)(?=\s*(?:#|$))', r'\g<1>true', text, flags=re.MULTILINE)
    if count != 1:
        raise RuntimeError('Cannot safely change checkout setting')
    newline = '\r\n' if '\r\n' in text else '\n'
    if not changed.endswith('\n'):
        changed += newline
    return (changed + 'LICENSE_CATALOG_FILE=/etc/tblink-licensing/catalog.json' + newline).encode(), settings


def atomic_write(path, data, owner, mode):
    staged = path.with_name(path.name + '.pending-' + uuid.uuid4().hex)
    with staged.open('xb') as stream:
        os.chmod(staged, mode)
        os.chown(staged, *owner)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(staged, path)


def backup_directory(root, name):
    """A new directory for this run's backup; every directory from root down is root's and writable by no one else."""
    current = root
    for part in ('', *Path(BACKUPS).parts):
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            raise RuntimeError(f'Backup directory missing: {current}') from None
        if not file_mode.S_ISDIR(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o022:
            raise RuntimeError(f'Backup directory must be root-only: {current}')
    backup = current / name
    backup.mkdir(mode=0o700)
    return backup


def restart():
    subprocess.run(['systemctl', 'restart', 'tblink-licensing'], check=True, capture_output=True, timeout=30)


def read_catalog():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(5):
        try:
            with opener.open('http://127.0.0.1:8787/v1/catalog', timeout=5) as response:
                return json.load(response)
        except urllib.error.URLError:
            if attempt == 4:
                raise
            time.sleep(0.5)
    raise RuntimeError('Catalog health check did not complete')


def activate(source, source_sha, environment_sha, root=Path('/')):
    data = source.read_bytes()
    if digest(data) != source_sha:
        raise RuntimeError('Catalog artifact differs from reviewed content')
    catalog = json.loads(data)
    offers = catalog.get('offers', [])
    if catalog.get('maxOrderAmountFen') != 800000 or len(offers) != 2:
        raise RuntimeError('Catalog differs from approved launch quantities')
    if sorted((offer['unitAmountFen'], offer['useDays'], offer['updatesDays'], offer['maxQuantity']) for offer in offers) != [(80000, 30, 30, 1), (800000, 365, 365, 1)]:
        raise RuntimeError('Catalog differs from approved launch pricing')
    environment = root / 'etc/tblink-licensing/service.env'
    target = root / 'etc/tblink-licensing/catalog.json'
    original = environment.read_bytes()
    if digest(original) != environment_sha or target.exists() or target.is_symlink():
        raise RuntimeError('Production environment or catalog drifted')
    updated, settings = sales_environment(original)
    for name in ('ALIPAY_PRIVATE_KEY_FILE', 'ALIPAY_PUBLIC_KEY_FILE'):
        if not (root / settings[name].lstrip('/')).is_file():
            raise RuntimeError('Payment key file is missing')
    if read_catalog() != {'available': False, 'currency': 'CNY', 'termStart': 'fulfillment', 'offers': []}:
        raise RuntimeError('Production sales are not closed')
    stat = environment.stat()
    owner = (stat.st_uid, stat.st_gid)
    mode = stat.st_mode & 0o777
    service_user = pwd.getpwnam('tblink-license')
    backup = backup_directory(root, datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-open-sales-' + uuid.uuid4().hex[:8])
    atomic_write(backup / 'previous-environment', original, owner, 0o600)
    atomic_write(backup / 'reviewed-catalog.json', data, owner, 0o600)
    installed = False
    try:
        atomic_write(target, data, (service_user.pw_uid, service_user.pw_gid), 0o600)
        installed = True
        atomic_write(environment, updated, owner, mode)
        restart()
        expected = {'available': True, 'currency': 'CNY', 'termStart': 'fulfillment', 'offers': offers}
        if read_catalog() != expected:
            raise RuntimeError('Active catalog differs from reviewed offers')
    except Exception:
        atomic_write(environment, original, owner, mode)
        if installed:
            os.replace(target, backup / 'failed-catalog.json')
        restart()
        if read_catalog() != {'available': False, 'currency': 'CNY', 'termStart': 'fulfillment', 'offers': []}:
            raise RuntimeError('Rollback did not restore closed sales; operator action required')
        raise
    return {'backup': str(backup), 'catalogSha256': digest(target.read_bytes()),
            'environmentSha256': digest(environment.read_bytes()), 'salesEnabled': True,
            'offers': [{'id': offer['id'], 'amountFen': offer['unitAmountFen'], 'useDays': offer['useDays']} for offer in offers]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('catalog', type=Path)
    parser.add_argument('catalog_sha256')
    parser.add_argument('environment_sha256')
    args = parser.parse_args()
    print(json.dumps(activate(args.catalog, args.catalog_sha256, args.environment_sha256)))


if __name__ == '__main__':
    os.umask(0o077)
    main()
