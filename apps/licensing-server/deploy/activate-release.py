#!/usr/bin/env python3
"""Activate a verified licensing bundle; execute as root on the company host."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def database_snapshot(path):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Database integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("Database foreign key check failed")
        result = {}
        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        for (name,) in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            rows = db.execute(f"SELECT * FROM {quoted} ORDER BY rowid").fetchall()
            result[name] = {"count": len(rows), "digest": hashlib.sha256(repr(rows).encode()).hexdigest()}
        return result


def atomic_copy(source, target, mode):
    staged = target.with_name(target.name + ".staged-" + uuid.uuid4().hex)
    shutil.copyfile(source, staged)
    os.chmod(staged, mode)
    os.replace(staged, target)


def health():
    with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=5) as response:
        return response.status == 200 and json.load(response) == {"status": "ok"}


def main():
    if os.geteuid() != 0 or len(sys.argv) != 5:
        raise RuntimeError("Usage as root: activate-release.py ARCHIVE ARCHIVE_SHA OLD_BUNDLE_SHA OLD_NGINX_SHA")
    archive, expected_archive, expected_old, expected_nginx = sys.argv[1:]
    artifact = Path(archive)
    bundle = Path("/opt/tblink-licensing/dist/index.js")
    nginx = Path("/etc/nginx/sites-available/tblink-licensing.conf")
    database = Path("/var/lib/tblink-licensing/license.db")
    if digest(artifact) != expected_archive or digest(bundle) != expected_old or digest(nginx) != expected_nginx:
        raise RuntimeError("Artifact or production state changed; inspect before retrying")
    os.umask(0o077)
    backup = Path("/var/lib/tblink-licensing/backups") / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tarfile.open(artifact) as tar:
        if sorted(tar.getnames()) != ["dist/index.js", "nginx-routes.conf", "revision.txt"]:
            raise RuntimeError("Unexpected release members")
        for member in tar.getmembers():
            if not member.isfile() or member.size > 2_000_000:
                raise RuntimeError("Invalid release member")
            source = tar.extractfile(member)
            if source is None:
                raise RuntimeError("Missing release member")
            target = backup / Path(member.name).name
            with target.open("xb") as output:
                output.write(source.read())
    revision = (backup / "revision.txt").read_text().strip()
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise RuntimeError("Invalid source revision")
    old_nginx = nginx.read_text()
    if "/v1/orders/" in old_nginx or "/v1/payments/alipay/notify" in old_nginx:
        raise RuntimeError("Routes already present; inspect instead of duplicating")
    api_start = old_nginx.index("server_name api.tuanbo-link.jinhefilm.com;")
    insertion = old_nginx.index("    location / { return 404; }", api_start)
    (backup / "nginx.next.conf").write_text(old_nginx[:insertion] + (backup / "nginx-routes.conf").read_text() + old_nginx[insertion:])
    shutil.copyfile(bundle, backup / "previous.js")
    shutil.copyfile(nginx, backup / "previous-nginx.conf")
    services = ["jinhe-storyboard.service", "wuyou-dispatch.service", "nginx.service"]
    for name in services:
        run("systemctl", "is-active", name)
    run("/usr/bin/node", "--check", str(backup / "index.js"))
    run("systemctl", "stop", "tblink-licensing.service")
    activated = False
    try:
        # Stop the sole writer, then SQLite's backup API captures all committed WAL content.
        before = database_snapshot(database)
        with sqlite3.connect(str(database)) as source, sqlite3.connect(str(backup / "license.db")) as target:
            source.backup(target)
        with sqlite3.connect(str(backup / "license.db")) as source, sqlite3.connect(str(backup / "restore-check.db")) as target:
            source.backup(target)
        if database_snapshot(backup / "restore-check.db") != before:
            raise RuntimeError("Backup restore differs from production data")
        atomic_copy(backup / "index.js", bundle, 0o644)
        atomic_copy(backup / "nginx.next.conf", nginx, 0o644)
        run("nginx", "-t")
        run("systemctl", "start", "tblink-licensing.service")
        for attempt in range(10):
            try:
                if health():
                    break
            except (urllib.error.URLError, TimeoutError):
                if attempt == 9:
                    raise RuntimeError("New service health check failed")
            time.sleep(0.3)
        else:
            raise RuntimeError("New service health check failed")
        after = database_snapshot(database)
        if any(after.get(name) != value for name, value in before.items()):
            raise RuntimeError("Existing data changed during migration")
        if "order_delivery_access" not in after:
            raise RuntimeError("Delivery table was not created")
        run("systemctl", "reload", "nginx.service")
        for name in ["tblink-licensing.service", *services]:
            run("systemctl", "is-active", name)
        manifest = {"revision": revision, "bundleSha256": digest(bundle), "previousBundleSha256": expected_old,
                    "nginxSha256": digest(nginx), "backupRestoreVerified": True, "existingTablesPreserved": True}
        (backup / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        Path("/opt/tblink-licensing/RELEASE").write_text(revision + "\n")
        activated = True
        print(json.dumps({**manifest, "backup": str(backup)}))
    finally:
        if not activated:
            # Migration only adds a table. Preserve the database instead of discarding any committed writes.
            run("systemctl", "stop", "tblink-licensing.service")
            atomic_copy(backup / "previous.js", bundle, 0o644)
            atomic_copy(backup / "previous-nginx.conf", nginx, 0o644)
            run("nginx", "-t")
            run("systemctl", "start", "tblink-licensing.service")
            run("systemctl", "reload", "nginx.service")
            print("Activation failed; previous code and proxy restored", file=sys.stderr)


if __name__ == "__main__":
    main()
