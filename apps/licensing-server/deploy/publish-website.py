#!/usr/bin/env python3
"""Publish the static website while preserving services and the current sales catalog."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

HOST = 'tuanbo-link.jinhefilm.com'
NGINX = Path('/etc/nginx/sites-available/tblink-licensing.conf')
ROOT = Path('/srv/tblink-purchase')
RELEASES = Path('/srv/tblink-purchase-releases')
# Root's backups. Never inside a service account's directory: the licensing account owns /var/lib/tblink-licensing
# and could swap the validated files there before they are copied into the public release.
BACKUPS = Path('/var/backups/tblink')
TRUSTED = Path('/')
ROOT_UID = 0
PROTECTED = [Path('/opt/tblink-licensing/dist/index.js'), Path('/etc/tblink-licensing/service.env')]
STATIC_FILES = {'index.html', 'purchase.js', 'purchase.css', 'assets/studio.webp', 'assets/display.woff2', 'assets/FONT-LICENSE.txt'}
STATIC_FILES |= {'site.js', 'site.css', 'download/index.html', 'guide/index.html', 'purchase/index.html', 'terms/index.html', 'refund/index.html', 'privacy/index.html', 'media.json', 'release.json', 'robots.txt', 'sitemap.xml', 'website-manifest.json', 'assets/20261010-programs.webp', 'assets/20261010-timeline.webp', 'assets/20261010-cameras.webp', 'assets/20261010-lighting.webp', 'assets/20261010-connections.webp', 'assets/20261010-rehearsal.webp', 'media/20261010-programs.mp4', 'media/20261010-timeline.mp4', 'media/20261010-cameras.mp4', 'media/20261010-lighting.mp4', 'media/20261010-overview.mp4', 'media/20261010-overview.vtt'}
FILES = STATIC_FILES | {'revision.txt', 'nginx.previous.conf', 'nginx.next.conf'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30)


def backup_directory(name):
    """A new directory for this run's backup; every directory from / down is root's and writable by no one else."""
    current = TRUSTED
    for part in ('', *BACKUPS.relative_to(TRUSTED).parts):
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            raise RuntimeError(f'Backup directory missing: {current}') from None
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o022:
            raise RuntimeError(f'Backup directory must be root-only: {current}')
    backup = BACKUPS / name
    backup.mkdir(mode=0o700)
    return backup


def site_sections(config):
    marker = f'    server_name {HOST};\n'
    if config.count(marker) != 1:
        raise RuntimeError('Expected one website HTTPS block')
    pos = config.index(marker)
    start = config.rfind('server {\n', 0, pos)
    end = config.find('\n}\n', pos)
    if start < 0 or end < 0:
        raise RuntimeError('Unsupported site configuration layout')
    return config[:start], config[start:end + 3], config[end + 3:]


def validate_config(previous, candidate):
    before, _, after = site_sections(previous)
    next_before, site, next_after = site_sections(candidate)
    if (before, after) != (next_before, next_after):
        raise RuntimeError('Only the website block may change')
    root_match = re.search(r'^    root (.+);$', site, re.M)
    if not root_match or Path(root_match.group(1)) != ROOT or site.count('proxy_pass http://127.0.0.1:8787;') != 4:
        raise RuntimeError('Unexpected website root or proxy routes')
    expected = {'= /', '= /purchase.js', '= /purchase.css', '= /assets/studio.webp', '= /assets/display.woff2', '= /assets/FONT-LICENSE.txt', '~ "^/media/[a-z0-9][a-z0-9-]*\\.mp4$"',
                '= /v1/catalog', '= /v1/orders', '~ "^/v1/orders/[a-f0-9-]{36}$"', '~ "^/v1/orders/[a-f0-9-]{36}/reconcile$"'}
    expected |= {'= /download/', '= /guide/', '= /purchase/', '= /terms/', '= /refund/', '= /privacy/'} | {'= /' + name for name in STATIC_FILES - {'index.html', 'download/index.html', 'guide/index.html', 'purchase/index.html', 'terms/index.html', 'refund/index.html', 'privacy/index.html'}}
    routes = dict(re.findall(r'    location (.*?) \{\n(.*?)\n    }', site, re.S))
    if set(routes) != expected or '    location / { return 404; }' not in site:
        raise RuntimeError('Unexpected exposed route')
    for name, body in routes.items():
        method = 'POST' if name == '= /v1/orders' or '/reconcile' in name else 'GET'
        if f'limit_except {method} {{ deny all; }}' not in body:
            raise RuntimeError('Missing method restriction')
        if '/v1/' in name and 'proxy_set_header X-Tblink-Client-IP $remote_addr;' not in body:
            raise RuntimeError('Missing trusted client address overwrite')
    for header in ['Cache-Control no-store always', 'X-Content-Type-Options nosniff always',
                   'Referrer-Policy no-referrer always', "frame-ancestors 'none'"]:
        if header not in site:
            raise RuntimeError('Missing security header')
    return candidate


def atomic_text(path, value):
    staged = path.with_name(path.name + '.staged-' + uuid.uuid4().hex)
    staged.write_text(value)
    os.chmod(staged, 0o644)
    os.replace(staged, path)


def validate_files(directory):
    manifest = json.loads((directory / 'website-manifest.json').read_text(encoding='utf-8'))
    if set(manifest) != {'version', 'files'} or manifest['version'] != 1:
        raise RuntimeError('Invalid website manifest')
    if set(manifest['files']) != STATIC_FILES - {'website-manifest.json'}:
        raise RuntimeError('Website manifest file list differs from allowlist')
    for name, entry in manifest['files'].items():
        if set(entry) != {'size', 'sha256'} or type(entry['size']) is not int:
            raise RuntimeError('Invalid website file metadata')
        file = directory / name
        if file.stat().st_size != entry['size'] or digest(file) != entry['sha256']:
            raise RuntimeError('Website artifact checksum mismatch: ' + name)


def read_catalog():
    with urllib.request.urlopen('http://127.0.0.1:8787/v1/catalog', timeout=5) as response:
        value = json.load(response)
    if not isinstance(value.get('available'), bool) or not isinstance(value.get('offers'), list):
        raise RuntimeError('Unexpected catalog response')
    return value


def probe(path):
    return run('curl', '--fail', '--silent', '--show-error', '--max-time', '3', '--noproxy', '*',
               '--resolve', f'{HOST}:443:127.0.0.1', f'https://{HOST}{path}').stdout


def wait_for_page(expected, expected_manifest):
    # Old workers see the new symlink too, so HTML alone cannot prove new routes are loaded.
    observed = None
    for attempt in range(10):
        try:
            page = probe('/')
            observed = hashlib.sha256(page.encode()).hexdigest()
            if page == expected and probe('/website-manifest.json') == expected_manifest:
                return
        except subprocess.CalledProcessError:
            observed = 'request failed'
        if attempt < 9:
            time.sleep(0.25)
    raise RuntimeError('Live HTML differs from built artifact after reload; observed SHA256: ' + str(observed))


def verify_live_files(release):
    for name in sorted(STATIC_FILES):
        path = '/' if name == 'index.html' else '/' + name.removesuffix('index.html') if name.endswith('/index.html') else '/' + name
        response = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '30',
                                   '--noproxy', '*', '--resolve', f'{HOST}:443:127.0.0.1',
                                   f'https://{HOST}{path}'], check=True, capture_output=True, timeout=35)
        if hashlib.sha256(response.stdout).hexdigest() != digest(release / name):
            raise RuntimeError('Live artifact checksum mismatch: ' + name)
        if name.endswith('.mp4'):
            headers = run('curl', '--fail', '--silent', '--show-error', '--max-time', '10', '--noproxy', '*',
                          '--resolve', f'{HOST}:443:127.0.0.1', '--range', '0-1023', '--dump-header', '-',
                          '--output', '/dev/null', f'https://{HOST}{path}').stdout.lower()
            if not re.search(r'^http/[^ ]+ 206\b', headers, re.M) or f'content-range: bytes 0-1023/{(release / name).stat().st_size}' not in headers:
                raise RuntimeError('Video range request failed: ' + name)


def main():
    if len(sys.argv) != 6 or os.geteuid() != 0:
        raise RuntimeError('Run as root: publish-website.py ARCHIVE ARCHIVE_SHA NGINX_SHA BUNDLE_SHA ENV_SHA')
    artifact = Path(sys.argv[1])
    if digest(artifact) != sys.argv[2] or digest(NGINX) != sys.argv[3]:
        raise RuntimeError('Archive or current proxy changed')
    protected = [digest(path) for path in PROTECTED]
    if protected != sys.argv[4:6]:
        raise RuntimeError('Protected service files changed')
    if ROOT.exists() and not ROOT.is_symlink():
        raise RuntimeError('Refusing to replace an unmanaged directory')
    old_target = os.readlink(ROOT) if ROOT.is_symlink() else None
    if old_target and not Path(old_target).resolve().is_relative_to(RELEASES.resolve()):
        raise RuntimeError('Unmanaged static release link')
    catalog = read_catalog()
    services = ['nginx', 'tblink-licensing', 'jinhe-storyboard', 'wuyou-dispatch']
    for unit in services:
        if run('systemctl', 'is-active', unit).stdout.strip() != 'active':
            raise RuntimeError('Expected healthy existing services')
    backup = backup_directory(time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-website')
    with tarfile.open(artifact) as archive:
        members = archive.getmembers()
        if {item.name for item in members} != FILES or len(members) != len(FILES):
            raise RuntimeError('Unexpected release archive members')
        for item in members:
            limit = 40_000_000 if item.name.endswith('.mp4') else 2_000_000
            if not item.isfile() or item.size <= 0 or item.size > limit:
                raise RuntimeError('Invalid archive entry')
            stream = archive.extractfile(item)
            if stream is None:
                raise RuntimeError('Missing archive entry')
            (backup / item.name).parent.mkdir(exist_ok=True)
            (backup / item.name).write_bytes(stream.read())
    validate_files(backup)
    previous = NGINX.read_text()
    if previous != (backup / 'nginx.previous.conf').read_text():
        raise RuntimeError('Prior proxy does not match inspected state')
    candidate = validate_config(previous, (backup / 'nginx.next.conf').read_text())
    revision = (backup / 'revision.txt').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise RuntimeError('Invalid revision')
    (backup / 'rollback.json').write_text(json.dumps({'previousRoot': old_target, 'previousNginxSha256': digest(NGINX)}))
    preflight = backup / 'nginx-preflight.conf'
    preflight.write_text('error_log stderr;\nevents {}\nhttp {\ninclude /etc/nginx/mime.types;\naccess_log off;\n' + candidate + '\n}\n')
    run('nginx', '-t', '-c', str(preflight))
    RELEASES.mkdir(mode=0o755, exist_ok=True)
    RELEASES.chmod(0o755)
    release = RELEASES / (revision + '-' + uuid.uuid4().hex[:8])
    release.mkdir(mode=0o755)
    # The receiver runs with umask 077; only public static directories need traversal.
    release.chmod(0o755)
    for name in STATIC_FILES:
        (release / name).parent.mkdir(exist_ok=True)
        (release / name).parent.chmod(0o755)
        shutil.copyfile(backup / name, release / name)
        os.chmod(release / name, 0o644)
    changed = False
    try:
        staged_link = ROOT.with_name(ROOT.name + '.staged-' + uuid.uuid4().hex)
        staged_link.symlink_to(release)
        os.replace(staged_link, ROOT)
        changed = True
        atomic_text(NGINX, candidate)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        wait_for_page((release / 'index.html').read_text(), (release / 'website-manifest.json').read_text())
        verify_live_files(release)
        if json.loads(probe('/v1/catalog')) != catalog:
            raise RuntimeError('Sales catalog changed during website release')
        if [digest(path) for path in PROTECTED] != protected:
            raise RuntimeError('Protected files changed during release')
        for unit in services:
            if run('systemctl', 'is-active', unit).stdout.strip() != 'active':
                raise RuntimeError('Existing service health changed')
        manifest = {'revision': revision, 'backup': str(backup), 'release': str(release),
                    'files': {name: digest(release / name) for name in STATIC_FILES},
                    'nginxSha256': digest(NGINX), 'protectedFilesUnchanged': True, 'catalogUnchanged': True}
        (backup / 'result.json').write_text(json.dumps(manifest, indent=2))
        print(json.dumps(manifest, indent=2))
    except BaseException:
        if changed:
            atomic_text(NGINX, previous)
            if old_target:
                recovery = ROOT.with_name(ROOT.name + '.rollback-' + uuid.uuid4().hex)
                recovery.symlink_to(old_target)
                os.replace(recovery, ROOT)
            else:
                ROOT.rename(ROOT.with_name(ROOT.name + '.failed-' + uuid.uuid4().hex))
            run('nginx', '-t')
            run('systemctl', 'reload', 'nginx')
        raise


if __name__ == '__main__':
    main()
