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
    files.update({'web/' + name: (HERE.parent / 'dist/web' / name).read_bytes() for name in STATIC})
    manifest = {'revision': revision, 'repository': os.environ['GITHUB_REPOSITORY'],
                'runId': int(os.environ['GITHUB_RUN_ID']), 'attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
                'tools': {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                          for name in ['activate-release.py', 'publish-website.py', 'receive-release.py']}}
    files['manifest.json'] = json.dumps(manifest).encode()
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w') as archive:
        for name, value in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size = len(value)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(value))
    # Never put deployment credentials into the checkout or forward them to SSH's environment.
    directory = Path(tempfile.mkdtemp(prefix='tblink-ci-deploy-'))
    os.chmod(directory, 0o700)
    key = directory / 'identity'
    known_hosts = directory / 'known_hosts'
    key.write_text(os.environ.pop('TBLINK_DEPLOY_SSH_KEY'))
    key.chmod(0o600)
    known_hosts.write_text(os.environ.pop('TBLINK_DEPLOY_KNOWN_HOSTS'))
    known_hosts.chmod(0o600)
    try:
        deployed = subprocess.run(['ssh', '-F', '/dev/null', '-T', '-i', str(key),
                                  '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                                  '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known_hosts),
                                  '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
                                  '-o', 'ServerAliveCountMax=3', 'tblink-deploy@123.206.229.200'],
                                 input=data.getvalue(), capture_output=True, timeout=1560)
    finally:
        key.write_bytes(b'')
    if deployed.returncode:
        raise RuntimeError('Restricted deployment failed; inspect its root-only server job record. ' + deployed.stderr.decode(errors='replace')[-2000:])
    result = json.loads(deployed.stdout)
    if result.get('status') != 'success' or result.get('revision') != revision or result.get('files') != manifest['files']:
        raise RuntimeError('Server receipt does not match the uploaded build')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write('\nDeployed server and website from `' + revision + '`.\n')
        summary.write('Server backups: `' + result['runtimeBackup'] + '`, `' + result['websiteBackup'] + '`.\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
