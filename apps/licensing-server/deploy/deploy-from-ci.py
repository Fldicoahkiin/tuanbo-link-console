#!/usr/bin/env python3
"""Package checked CI output and send it to the pinned, restricted SSH receiver."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
STATIC = ['index.html', 'purchase.js', 'purchase.css', 'assets/studio.webp',
          'assets/display.woff2', 'assets/FONT-LICENSE.txt']
STATIC += ["site.js","site.css","download/index.html","guide/index.html","purchase/index.html","terms/index.html","refund/index.html","privacy/index.html","media.json","release.json","robots.txt","sitemap.xml","website-manifest.json","assets/20261010-programs.webp","assets/20261010-timeline.webp","assets/20261010-cameras.webp","assets/20261010-lighting.webp","assets/20261010-connections.webp","assets/20261010-rehearsal.webp","media/20261010-programs.mp4","media/20261010-timeline.mp4","media/20261010-cameras.mp4","media/20261010-lighting.mp4","media/20261010-overview.mp4","media/20261010-overview.vtt"]


def pack(files):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w') as archive:
        for name, value in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size = len(value)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(value))
    return data.getvalue()


def deliver(send, files, manifest):
    """Ask the receiver which artifacts production lacks, then upload only those."""
    encoded = json.dumps(manifest).encode()
    plan = send(pack({'manifest.json': encoded}), 120)
    upload = plan.get('upload') if plan.get('status') == 'plan' else None
    if not isinstance(upload, list) or not set(upload) <= set(files):
        raise RuntimeError('Server returned an invalid upload plan')
    if not upload:
        return None
    payload = pack({**{name: files[name] for name in upload}, 'manifest.json': encoded})
    print(f'Uploading {len(upload)} of {len(files)} artifacts ({len(payload)} bytes)', flush=True)
    # Upload window plus the server's activation wait.
    return send(payload, 2460)


def write_ssh_file(path, value):
    # Secret input can lose the final newline required by OpenSSH private keys.
    path.write_text(value.rstrip('\r\n') + '\n')
    path.chmod(0o600)


def main():
    revision = os.environ['GITHUB_SHA']
    if (os.environ['GITHUB_REPOSITORY'] != 'JinHe9527/tuanbo-link-console'
            or os.environ['GITHUB_REF'] != 'refs/heads/master' or not re.fullmatch('[a-f0-9]{40}', revision)):
        raise RuntimeError('Only the production repository and branch may deploy')
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    if head != revision:
        raise RuntimeError('CI checkout does not match requested revision')
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD'], check=True, capture_output=True, timeout=10)
    files = {'dist/index.js': (HERE.parent / 'dist/index.js').read_bytes()}
    files['dist/console-bootstrap.js'] = (HERE.parent / 'dist/console-bootstrap.js').read_bytes()
    files.update({'console/' + name: (HERE.parent / 'dist/console' / name).read_bytes()
                  for name in ['index.html', 'console.js', 'console.css', 'manifest.json']})
    files.update({'web/' + name: (HERE.parent / 'dist/web' / name).read_bytes() for name in STATIC})
    manifest = {'revision': revision, 'repository': os.environ['GITHUB_REPOSITORY'],
                'runId': int(os.environ['GITHUB_RUN_ID']), 'attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
                'tools': {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                          for name in ['activate-release.py', 'publish-website.py', 'publish-console.py', 'receive-release.py']}}
    # Never put deployment credentials into the checkout or forward them to SSH's environment.
    directory = Path(tempfile.mkdtemp(prefix='tblink-ci-deploy-'))
    os.chmod(directory, 0o700)
    key = directory / 'identity'
    known_hosts = directory / 'known_hosts'
    try:
        write_ssh_file(key, os.environ.pop('TBLINK_DEPLOY_SSH_KEY'))
        write_ssh_file(known_hosts, os.environ.pop('TBLINK_DEPLOY_KNOWN_HOSTS'))
        def send(payload, timeout):
            deployed = subprocess.run(['ssh', '-F', '/dev/null', '-T', '-i', str(key),
                                      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                                      '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known_hosts),
                                      '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
                                      '-o', 'ServerAliveCountMax=3', 'tblink-deploy@123.206.229.200'],
                                     input=payload, capture_output=True, timeout=timeout)
            if deployed.returncode:
                raise RuntimeError('Restricted deployment failed; inspect its root-only server job record. ' + deployed.stderr.decode(errors='replace')[-2000:])
            return json.loads(deployed.stdout)

        result = deliver(send, files, manifest)
    finally:
        key.write_bytes(b'')
    if result is None:
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write('\nProduction already matches every artifact of `' + revision + '`; nothing was uploaded.\n')
        return
    if result.get('status') != 'success' or result.get('revision') != revision or result.get('files') != manifest['files']:
        raise RuntimeError('Server receipt does not match the uploaded build')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write('\nDeployed server and website from `' + revision + '`.\n')
        summary.write('Server backups: `' + result['runtimeBackup'] + '`, `' + result['websiteBackup'] + '`.\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
