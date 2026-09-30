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
import uuid

ROOT = Path('/var/lib/tblink-deploy')
POLICY = Path('/etc/tblink-deploy/policy.json')
NGINX = Path('/etc/nginx/sites-available/tblink-licensing.conf')
BUNDLE = Path('/opt/tblink-licensing/dist/index.js')
ENVIRONMENT = Path('/etc/tblink-licensing/service.env')
WEBSITE = Path('/srv/tblink-purchase')
TOOLS = {
    'activate-release.py': Path('/opt/tblink-licensing/activate-release.py'),
    'publish-website.py': Path('/opt/tblink-licensing/publish-website.py'),
    'receive-release.py': Path('/usr/local/libexec/tblink-receive-release.py'),
}
STATIC = {'index.html', 'purchase.js', 'purchase.css', 'assets/studio.webp',
          'assets/display.woff2', 'assets/FONT-LICENSE.txt'}
ARTIFACTS = {'dist/index.js'} | {'web/' + name for name in STATIC}
MAX_ARCHIVE = 16 * 1024 * 1024


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
            if not member.isfile() or member.size <= 0 or member.size > 2_000_000:
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


def verify_policy(manifest, policy, tool_digests, nginx_digest, previous):
    if tool_digests != manifest['tools'] or policy['nginxSha256'] != nginx_digest:
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
        verify_policy(manifest, policy, {name: digest(path) for name, path in TOOLS.items()}, digest(NGINX), previous)
        current_proxy = NGINX.read_bytes()
        protected_env = digest(ENVIRONMENT)
        common = {'revision.txt': manifest['revision'].encode(),
                  'nginx.previous.conf': current_proxy, 'nginx.next.conf': current_proxy}
        runtime = job / 'runtime.tar'
        website = job / 'website.tar'
        make_archive(runtime, {**common, 'dist/index.js': files['dist/index.js']})
        make_archive(website, {**common, **{name: files['web/' + name] for name in STATIC}})
        # The worker is owned by systemd, so losing SSH cannot interrupt activation.
        runtime_result = execute('activate-release.py', runtime, digest(runtime), digest(BUNDLE), digest(NGINX), protected_env)
        write_json(job / 'runtime-result.json', runtime_result)
        website_result = execute('publish-website.py', website, digest(website), digest(NGINX), digest(BUNDLE), protected_env)
        if digest(ENVIRONMENT) != protected_env or digest(NGINX) != policy['nginxSha256']:
            raise RuntimeError('Protected production configuration changed')
        if digest(BUNDLE) != manifest['files']['dist/index.js'] or any(
                digest(WEBSITE / name) != manifest['files']['web/' + name] for name in STATIC):
            raise RuntimeError('Installed files differ from CI artifacts')
        result = {'revision': manifest['revision'], 'runId': manifest['runId'], 'attempt': manifest['attempt'],
                  'runtimeBackup': runtime_result['backup'], 'websiteBackup': website_result['backup'],
                  'files': manifest['files'], 'status': 'success'}
        write_json(job / 'result.json', result)
        write_json(previous_path, result)
        return result


def receive(stream):
    if shutil.disk_usage(ROOT).free < 512 * 1024 * 1024:
        raise RuntimeError('Insufficient deployment disk space')
    data = stream.read(MAX_ARCHIVE + 1)
    manifest, _ = decode_archive(data)
    job_id = uuid.uuid4().hex
    job = ROOT / 'jobs' / job_id
    job.mkdir(mode=0o700, parents=True)
    (job / 'incoming.tar').write_bytes(data)
    write_json(job / 'request.json', {key: manifest[key] for key in ['revision', 'runId', 'attempt', 'repository']})
    signal.alarm(0)
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
        signal.alarm(60)
        print(json.dumps(receive(sys.stdin.buffer)))
    else:
        raise RuntimeError('Unsupported deployment invocation')


if __name__ == '__main__':
    main()
