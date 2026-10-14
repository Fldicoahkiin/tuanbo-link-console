#!/usr/bin/env python3
"""Restricted SSH receiver for verified runtime and website artifacts only."""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import uuid

ROOT = Path('/var/lib/tblink-deploy')
POLICY = Path('/etc/tblink-deploy/policy.json')
NGINX = Path('/etc/nginx/sites-available/tblink-licensing.conf')
CONSOLE_NGINX = Path('/etc/nginx/sites-available/tblink-console.conf')
BUNDLE = Path('/opt/tblink-licensing/dist/index.js')
ENVIRONMENT = Path('/etc/tblink-licensing/service.env')
WEBSITE = Path('/srv/tblink-purchase')
CONSOLE = Path('/srv/tblink-console')
CONSOLE_MAINTENANCE = Path('/srv/tblink-console-maintenance')
TOOLS = {
    'activate-release.py': Path('/opt/tblink-licensing/activate-release.py'),
    'publish-website.py': Path('/opt/tblink-licensing/publish-website.py'),
    'publish-console.py': Path('/opt/tblink-licensing/publish-console.py'),
    'receive-release.py': Path('/usr/local/libexec/tblink-receive-release.py'),
}
STATIC = {'index.html', 'purchase.js', 'purchase.css', 'assets/studio.webp',
          'assets/display.woff2', 'assets/FONT-LICENSE.txt'}
STATIC |= {'site.js', 'site.css', 'download/index.html', 'guide/index.html', 'purchase/index.html', 'terms/index.html', 'refund/index.html', 'privacy/index.html', 'media.json', 'release.json', 'robots.txt', 'sitemap.xml', 'website-manifest.json', 'assets/20261010-programs.webp', 'assets/20261010-timeline.webp', 'assets/20261010-cameras.webp', 'assets/20261010-lighting.webp', 'assets/20261010-connections.webp', 'assets/20261010-rehearsal.webp', 'media/20261010-programs.mp4', 'media/20261010-timeline.mp4', 'media/20261010-cameras.mp4', 'media/20261010-lighting.mp4', 'media/20261010-overview.mp4', 'media/20261010-overview.vtt'}
CONSOLE_FILES = {'index.html', 'console.js', 'console.css', 'manifest.json'}
ARTIFACTS = {'dist/index.js', 'dist/console-bootstrap.js'} | {'web/' + name for name in STATIC} | {'console/' + name for name in CONSOLE_FILES}
MAX_ARCHIVE = 128 * 1024 * 1024


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode_archive(data):
    if len(data) > MAX_ARCHIVE:
        raise RuntimeError('Deployment archive exceeds limit')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) != len(ARTIFACTS) + 1 or {m.name for m in members} != ARTIFACTS | {'manifest.json'}:
            raise RuntimeError('Unexpected deployment files')
        for member in members:
            limit = 40_000_000 if member.name.endswith('.mp4') else 2_000_000
            if not member.isfile() or member.size <= 0 or member.size > limit:
                raise RuntimeError('Invalid deployment member')
            with archive.extractfile(member) as stream:
                files[member.name] = stream.read()
    manifest = json.loads(files.pop('manifest.json'))
    if set(manifest) != {'revision', 'runId', 'attempt', 'repository', 'files', 'tools'}:
        raise RuntimeError('Unexpected deployment metadata')
    if (manifest['repository'] != 'JinHe9527/tuanbo-link-console'
            or not isinstance(manifest['revision'], str) or not re.fullmatch('[a-f0-9]{40}', manifest['revision'])
            or type(manifest['runId']) is not int or manifest['runId'] <= 0
            or type(manifest['attempt']) is not int or manifest['attempt'] <= 0):
        raise RuntimeError('Invalid deployment source')
    if set(manifest['files']) != ARTIFACTS or set(manifest['tools']) != set(TOOLS):
        raise RuntimeError('Unexpected artifact/tool manifest')
    if any(manifest['files'][name] != hashlib.sha256(value).hexdigest() for name, value in files.items()):
        raise RuntimeError('Deployment artifact checksum mismatch')
    if any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value) for value in manifest['tools'].values()):
        raise RuntimeError('Invalid deployment tool digest')
    return manifest, files


def verify_policy(manifest, policy, tool_digests, nginx_digest, console_nginx_digest, previous):
    if tool_digests != manifest['tools'] or policy['nginxSha256'] != nginx_digest or policy['consoleNginxSha256'] != console_nginx_digest:
        raise RuntimeError('Deployment tools or proxy require an operator-reviewed update')
    if previous and (manifest['runId'], manifest['attempt']) <= (previous['runId'], previous['attempt']):
        raise RuntimeError('Deployment run already completed or superseded')


def make_archive(path, files):
    with tarfile.open(path, 'w') as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))


def execute(tool, *args):
    result = subprocess.run(['/usr/bin/python3', str(TOOLS[tool]), *map(str, args)],
                            capture_output=True, text=True, timeout=600, check=True)
    return json.loads(result.stdout)


def write_json(path, value):
    staged = path.with_name(path.name + '.' + uuid.uuid4().hex)
    staged.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(staged, path)


def activate_job(job):
    with (ROOT / 'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, files = decode_archive((job / 'incoming.tar').read_bytes())
        previous_path = ROOT / 'last-success.json'
        previous = json.loads(previous_path.read_text()) if previous_path.exists() else None
        policy = json.loads(POLICY.read_text())
        verify_policy(manifest, policy, {name: digest(path) for name, path in TOOLS.items()}, digest(NGINX), digest(CONSOLE_NGINX), previous)
        current_proxy = NGINX.read_bytes()
        protected_env = digest(ENVIRONMENT)
        common = {'revision.txt': manifest['revision'].encode(),
                  'nginx.previous.conf': current_proxy, 'nginx.next.conf': current_proxy}
        runtime = job / 'runtime.tar'
        website = job / 'website.tar'
        console_archive = job / 'console.tar'
        make_archive(runtime, {**common, 'dist/index.js': files['dist/index.js']})
        make_archive(website, {**common, **{name: files['web/' + name] for name in STATIC}})
        make_archive(console_archive, {**{name: files['console/' + name] for name in CONSOLE_FILES}, 'console-bootstrap.js': files['dist/console-bootstrap.js']})
        # The worker is owned by systemd, so losing SSH cannot interrupt activation.
        # Prevent browser writes during the runtime's snapshot/migration verification.
        if CONSOLE_MAINTENANCE.exists():
            raise RuntimeError('Console maintenance is already active; investigate the previous release')
        CONSOLE_MAINTENANCE.write_text(manifest['revision'])
        CONSOLE_MAINTENANCE.chmod(0o644)
        paused_timers = []
        for unit in ['tblink-console-backup', 'tblink-console-health']:
            loaded = subprocess.run(['systemctl', 'show', unit + '.service', '--property=LoadState', '--value'], capture_output=True, text=True, timeout=10)
            if loaded.returncode == 0 and loaded.stdout.strip() == 'loaded':
                active = subprocess.run(['systemctl', 'is-active', '--quiet', unit + '.timer'], timeout=10)
                if active.returncode == 0:
                    paused_timers.append(unit + '.timer')
                subprocess.run(['systemctl', 'stop', unit + '.timer', unit + '.service'], check=True, capture_output=True, timeout=60)
        write_json(job / 'paused-console-timers.json', paused_timers)
        runtime_result = execute('activate-release.py', runtime, digest(runtime), digest(BUNDLE), digest(NGINX), protected_env)
        write_json(job / 'runtime-result.json', runtime_result)
        website_result = execute('publish-website.py', website, digest(website), digest(NGINX), digest(BUNDLE), protected_env)
        console_result = execute('publish-console.py', console_archive, digest(console_archive))
        if digest(ENVIRONMENT) != protected_env or digest(NGINX) != policy['nginxSha256'] or digest(CONSOLE_NGINX) != policy['consoleNginxSha256']:
            raise RuntimeError('Protected production configuration changed')
        if digest(BUNDLE) != manifest['files']['dist/index.js'] or any(
                digest(WEBSITE / name) != manifest['files']['web/' + name] for name in STATIC) or any(
                digest(CONSOLE / name) != manifest['files']['console/' + name] for name in CONSOLE_FILES):
            raise RuntimeError('Installed files differ from CI artifacts')
        result = {'revision': manifest['revision'], 'runId': manifest['runId'], 'attempt': manifest['attempt'],
                  'runtimeBackup': runtime_result['backup'], 'websiteBackup': website_result['backup'],
                  'consoleBackup': console_result['backup'],
                  'files': manifest['files'], 'status': 'success'}
        for timer in paused_timers:
            subprocess.run(['systemctl', 'start', timer], check=True, capture_output=True, timeout=30)
        CONSOLE_MAINTENANCE.unlink()
        write_json(job / 'result.json', result)
        write_json(previous_path, result)
        return result


def receive(stream):
    if shutil.disk_usage(ROOT).free < 512 * 1024 * 1024:
        raise RuntimeError('Insufficient deployment disk space')
    started = time.monotonic()
    chunks = []
    received = 0

    def upload_timeout(signum, frame):
        raise TimeoutError(f'Deployment upload timed out after receiving {received} bytes')

    previous_handler = signal.signal(signal.SIGALRM, upload_timeout)
    signal.alarm(300)
    try:
        while received <= MAX_ARCHIVE:
            chunk = stream.read1(min(65536, MAX_ARCHIVE + 1 - received))
            if not chunk:
                break
            chunks.append(chunk)
            received += len(chunk)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)
    data = b''.join(chunks)
    print(f'Received {received} deployment bytes in {time.monotonic() - started:.1f}s', file=sys.stderr)
    manifest, _ = decode_archive(data)
    job_id = uuid.uuid4().hex
    job = ROOT / 'jobs' / job_id
    job.mkdir(mode=0o700, parents=True)
    (job / 'incoming.tar').write_bytes(data)
    write_json(job / 'request.json', {key: manifest[key] for key in ['revision', 'runId', 'attempt', 'repository']})
    subprocess.run(['systemd-run', '--quiet', '--collect', '--wait', '--service-type=exec',
                    '--unit=tblink-deploy-' + job_id, '/usr/bin/python3', str(TOOLS['receive-release.py']),
                    '--job', job_id], check=True, timeout=1500)
    return json.loads((job / 'result.json').read_text())


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Deployment receiver requires its restricted sudo entry')
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == '--job' and re.fullmatch('[a-f0-9]{32}', sys.argv[2]):
        job = ROOT / 'jobs' / sys.argv[2]
        try:
            activate_job(job)
        except Exception as error:
            # Keep detailed command output in the root-only journal, not public CI logs.
            write_json(job / 'failure.json', {'type': type(error).__name__, 'status': 'failed'})
            if isinstance(error, subprocess.CalledProcessError) and error.stderr:
                print(error.stderr, file=sys.stderr)
            raise
    elif len(sys.argv) == 1:
        print(json.dumps(receive(sys.stdin.buffer)))
    else:
        raise RuntimeError('Unsupported deployment invocation')


if __name__ == '__main__':
    main()
