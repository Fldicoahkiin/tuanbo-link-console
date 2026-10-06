"""Publish verified console assets separately from the customer website."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import uuid

ROOT = Path('/srv/tblink-console')
RELEASES = Path('/srv/tblink-console-releases')
BOOTSTRAP = Path('/opt/tblink-licensing/dist/console-bootstrap.js')
FILES = {'index.html', 'console.js', 'console.css', 'manifest.json', 'console-bootstrap.js'}


def read_release(archive_path, expected):
    if hashlib.sha256(archive_path.read_bytes()).hexdigest() != expected:
        raise RuntimeError('Console archive digest mismatch')
    with tarfile.open(archive_path, 'r:') as archive:
        members = archive.getmembers()
        if len(members) != len(FILES) or {m.name for m in members} != FILES:
            raise RuntimeError('Unexpected console members')
        files = {}
        for member in members:
            if not member.isfile() or member.size < 1 or member.size > 2_000_000:
                raise RuntimeError('Invalid console member')
            with archive.extractfile(member) as stream:
                files[member.name] = stream.read()
    manifest = json.loads(files['manifest.json'])
    if manifest.get('version') != 1 or set(manifest.get('files', {})) != FILES - {'manifest.json', 'console-bootstrap.js'}:
        raise RuntimeError('Invalid console manifest')
    for name, expected_digest in manifest['files'].items():
        if hashlib.sha256(files[name]).hexdigest() != expected_digest:
            raise RuntimeError('Console asset digest mismatch')
    return files


def publish(archive_path, expected):
    files = read_release(archive_path, expected)
    RELEASES.mkdir(mode=0o755, parents=True, exist_ok=True)
    if ROOT.exists() and not ROOT.is_symlink():
        raise RuntimeError('Console root must be a managed symlink')
    previous = str(ROOT.resolve()) if ROOT.is_symlink() else None
    if previous and not Path(previous).is_relative_to(RELEASES.resolve()):
        raise RuntimeError('Previous console root is outside managed releases')
    release = RELEASES / uuid.uuid4().hex
    release.mkdir(mode=0o755)
    for name, content in files.items():
        if name == 'console-bootstrap.js':
            continue
        path = release / name
        path.write_bytes(content)
        path.chmod(0o644)
    receipt = {'status': 'success', 'backup': previous, 'release': str(release), 'archiveSha256': expected}
    (release / 'deployment.json').write_text(json.dumps(receipt))
    staged_bootstrap = BOOTSTRAP.with_name('console-bootstrap.' + uuid.uuid4().hex + '.js')
    staged_bootstrap.write_bytes(files['console-bootstrap.js'])
    staged_bootstrap.chmod(0o644)
    os.replace(staged_bootstrap, BOOTSTRAP)
    staged = ROOT.with_name(ROOT.name + '.' + uuid.uuid4().hex)
    staged.symlink_to(release, target_is_directory=True)
    os.replace(staged, ROOT)
    return receipt


if __name__ == '__main__':
    if len(sys.argv) != 3 or not re.fullmatch('[a-f0-9]{64}', sys.argv[2]) or os.geteuid() != 0:
        raise RuntimeError('Usage as root: publish-console.py ARCHIVE SHA256')
    os.umask(0o022)
    print(json.dumps(publish(Path(sys.argv[1]), sys.argv[2])))
