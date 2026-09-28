#!/usr/bin/env python3
"""Activate a verified licensing bundle; execute as root on the company host."""
import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
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
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
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


def atomic_copy(source, target, mode, owner=None):
    staged = target.with_name(target.name + ".staged-" + uuid.uuid4().hex)
    shutil.copyfile(source, staged)
    os.chmod(staged, mode)
    if owner is not None:
        os.chown(staged, *owner)
    os.replace(staged, target)


def health():
    with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=5) as response:
        return response.status == 200 and json.load(response) == {"status": "ok"}


def wait_health():
    for attempt in range(10):
        try:
            if health():
                return
        except (urllib.error.URLError, TimeoutError):
            if attempt == 9:
                raise RuntimeError("Service health check failed")
        time.sleep(0.3)
    raise RuntimeError("Service health check failed")


def api_sections(config):
    marker = "    server_name api.tuanbo-link.jinhefilm.com;\n"
    if config.count(marker) != 1:
        raise RuntimeError("Expected exactly one API server")
    domain = config.index(marker)
    start = config.rfind("server {\n", 0, domain)
    end = config.find("\n}\n", domain)
    if start < 0 or end < 0:
        raise RuntimeError("Unsupported API server layout")
    end += 3
    return config[:start], config[start:end], config[end:]


def next_proxy_config(current, previous, candidate):
    if current not in (previous, candidate):
        raise RuntimeError("Existing proxy differs from inspected release state")
    before, _, after = api_sections(previous)
    next_before, api, next_after = api_sections(candidate)
    if before != next_before or after != next_after:
        raise RuntimeError("Release may only change the API server block")
    routes = dict(re.findall(r"    location (.*?) \{\n(.*?)\n    }", api, re.S))
    expected = {"= /health": "GET", "= /v1/activate": "POST", "= /v1/catalog": "GET", "= /v1/orders": "POST",
                '~ "^/v1/orders/[a-f0-9-]{36}$"': "GET", '= /v1/payments/alipay/notify': "POST"}
    if set(routes) != set(expected) or api.count("proxy_pass ") != len(expected):
        raise RuntimeError("Unexpected public routes")
    for route, method in expected.items():
        block = routes[route]
        if (block.count("proxy_set_header X-Tblink-Client-IP $remote_addr;") != 1
                or block.count("proxy_pass http://127.0.0.1:8787;") != 1
                or f"limit_except {method} {{ deny all; }}" not in block):
            raise RuntimeError("Every API route must overwrite client IP and restrict its method")
    if api.count("    location / { return 404; }") != 1:
        raise RuntimeError("Public fallback must remain closed")
    return candidate


def maintenance_config(config):
    api_sections(config)
    marker = "    server_name api.tuanbo-link.jinhefilm.com;\n"
    return config.replace(marker, marker + "    return 503;\n", 1)


def proxy_environment(current):
    lines = current.splitlines(keepends=True)
    values = {}
    keys = {"LICENSE_HOST", "LICENSE_PROXY_MODE", "ALIPAY_CHECKOUT_ENABLED"}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in keys:
            continue
        if key in values:
            raise RuntimeError("Duplicate deployment setting")
        values[key] = value.strip().strip('"').strip("'")
    if values.get("LICENSE_HOST", "127.0.0.1") not in ("127.0.0.1", "::1"):
        raise RuntimeError("Trusted proxy requires a loopback listener")
    if values.get("ALIPAY_CHECKOUT_ENABLED", "false") != "false":
        raise RuntimeError("This rollout requires sales to remain disabled")
    if values.get("LICENSE_PROXY_MODE", "none") not in ("none", "loopback"):
        raise RuntimeError("Unknown proxy mode")
    if values.get("LICENSE_PROXY_MODE") == "loopback":
        return current
    for index, line in enumerate(lines):
        if line.split("=", 1)[0].strip() == "LICENSE_PROXY_MODE":
            ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            lines[index] = line.split("=", 1)[0] + "=loopback" + ending
            return "".join(lines)
    newline = "\r\n" if "\r\n" in current else "\n"
    return current + ("" if current.endswith("\n") or not current else newline) + "LICENSE_PROXY_MODE=loopback" + newline


def catalog_closed():
    with urllib.request.urlopen("http://127.0.0.1:8787/v1/catalog", timeout=5) as response:
        return response.status == 200 and json.load(response) == {"available": False, "currency": "CNY", "termStart": "fulfillment", "offers": []}


def main():
    if os.geteuid() != 0 or len(sys.argv) != 6:
        raise RuntimeError("Usage as root: activate-release.py ARCHIVE ARCHIVE_SHA OLD_BUNDLE_SHA OLD_NGINX_SHA OLD_ENV_SHA")
    archive, expected_archive, expected_old, expected_nginx, expected_environment = sys.argv[1:]
    artifact = Path(archive)
    bundle = Path("/opt/tblink-licensing/dist/index.js")
    nginx = Path("/etc/nginx/sites-available/tblink-licensing.conf")
    database = Path("/var/lib/tblink-licensing/license.db")
    environment = Path("/etc/tblink-licensing/service.env")
    if digest(artifact) != expected_archive or digest(bundle) != expected_old or digest(nginx) != expected_nginx or digest(environment) != expected_environment:
        raise RuntimeError("Artifact or production state changed; inspect before retrying")
    os.umask(0o077)
    backup = Path("/var/lib/tblink-licensing/backups") / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tarfile.open(artifact) as tar:
        if sorted(tar.getnames()) != ["dist/index.js", "nginx.next.conf", "nginx.previous.conf", "revision.txt"]:
            raise RuntimeError("Unexpected release members")
        for member in tar.getmembers():
            if not member.isfile() or member.size > 2_000_000:
                raise RuntimeError("Invalid release member")
            source = tar.extractfile(member)
            if source is None:
                raise RuntimeError("Missing release member")
            target = backup / Path(member.name).name
            with source, target.open("xb") as output:
                output.write(source.read())
    revision = (backup / "revision.txt").read_text().strip()
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise RuntimeError("Invalid source revision")
    old_nginx = nginx.read_text()
    next_nginx = next_proxy_config(old_nginx, (backup / "nginx.previous.conf").read_text(), (backup / "nginx.next.conf").read_text())
    proxy_changed = next_nginx != old_nginx
    (backup / "nginx.preflight.conf").write_text("error_log stderr;\nevents {}\nhttp {\naccess_log off;\n" + next_nginx + "\n}\n")
    run("nginx", "-t", "-c", str(backup / "nginx.preflight.conf"))
    (backup / "nginx.maintenance.conf").write_text(maintenance_config(next_nginx))
    environment_stat = environment.stat()
    environment_mode = stat.S_IMODE(environment_stat.st_mode)
    environment_owner = (environment_stat.st_uid, environment_stat.st_gid)
    next_environment = proxy_environment(environment.read_bytes().decode())
    (backup / "environment.next").write_bytes(next_environment.encode())
    shutil.copyfile(bundle, backup / "previous.js")
    shutil.copyfile(nginx, backup / "previous-nginx.conf")
    shutil.copyfile(environment, backup / "previous-environment")
    services = ["jinhe-storyboard.service", "wuyou-dispatch.service", "nginx.service"]
    for name in services:
        run("systemctl", "is-active", name)
    run("/usr/bin/node", "--check", str(backup / "index.js"))
    activated = False
    try:
        run("systemctl", "stop", "tblink-licensing.service")
        # Keep public API traffic out while checking the migrated database and closed catalog.
        atomic_copy(backup / "nginx.maintenance.conf", nginx, 0o644)
        run("nginx", "-t")
        run("systemctl", "reload", "nginx.service")
        # Stop the sole writer, then SQLite's backup API captures all committed WAL content.
        before = database_snapshot(database)
        with closing(sqlite3.connect(str(database))) as source, closing(sqlite3.connect(str(backup / "license.db"))) as target:
            source.backup(target)
        with closing(sqlite3.connect(str(backup / "license.db"))) as source, closing(sqlite3.connect(str(backup / "restore-check.db"))) as target:
            source.backup(target)
        if database_snapshot(backup / "restore-check.db") != before:
            raise RuntimeError("Backup restore differs from production data")
        atomic_copy(backup / "index.js", bundle, 0o644)
        atomic_copy(backup / "environment.next", environment, environment_mode, environment_owner)
        run("systemctl", "start", "tblink-licensing.service")
        wait_health()
        after = database_snapshot(database)
        if any(after.get(name) != value for name, value in before.items()):
            raise RuntimeError("Existing data changed during migration")
        if "order_delivery_access" not in after or "purchase_requests" not in after:
            raise RuntimeError("Delivery/purchase table was not created")
        if not catalog_closed():
            raise RuntimeError("Catalog must remain closed during this rollout")
        atomic_copy(backup / "nginx.next.conf", nginx, 0o644)
        run("nginx", "-t")
        run("systemctl", "reload", "nginx.service")
        for name in ["tblink-licensing.service", *services]:
            run("systemctl", "is-active", name)
        manifest = {"revision": revision, "bundleSha256": digest(bundle), "previousBundleSha256": expected_old,
                    "nginxSha256": digest(nginx), "proxyChanged": proxy_changed,
                    "environmentSha256": digest(environment), "proxyMode": "loopback", "catalogClosed": True,
                    "backupRestoreVerified": True, "existingTablesPreserved": True}
        (backup / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        atomic_copy(backup / "revision.txt", Path("/opt/tblink-licensing/RELEASE"), 0o644)
        activated = True
        print(json.dumps({**manifest, "backup": str(backup)}))
    finally:
        if not activated:
            # Only additive migrations are supported; never discard committed database writes.
            run("systemctl", "stop", "tblink-licensing.service")
            atomic_copy(backup / "previous.js", bundle, 0o644)
            atomic_copy(backup / "previous-environment", environment, environment_mode, environment_owner)
            atomic_copy(backup / "previous-nginx.conf", nginx, 0o644)
            run("nginx", "-t")
            run("systemctl", "reload", "nginx.service")
            run("systemctl", "start", "tblink-licensing.service")
            wait_health()
            print("Activation failed; previous code, environment and proxy restored", file=sys.stderr)


if __name__ == "__main__":
    main()
