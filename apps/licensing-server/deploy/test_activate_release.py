import importlib.util
from contextlib import closing
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("activate_release", Path(__file__).with_name("activate-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
template = Path(__file__).with_name("nginx.conf").read_text()
previous = template.replace("        proxy_set_header X-Tblink-Client-IP $remote_addr;\n", "")
for route in ("/v1/catalog", "/v1/orders"):
    previous = re.sub(r"    location = " + re.escape(route) + r" \{\n.*?\n    }\n", "", previous, flags=re.S)


class ProxyUpgradeTest(unittest.TestCase):
    def test_exact_upgrade_and_repeated_upgrade(self):
        self.assertEqual(release.next_proxy_config(previous, previous, template), template)
        self.assertEqual(release.next_proxy_config(template, previous, template), template)

    def test_reject_drift_and_changes_outside_api(self):
        with self.assertRaisesRegex(RuntimeError, "differs"):
            release.next_proxy_config(previous + "# unexpected\n", previous, template)
        with self.assertRaisesRegex(RuntimeError, "only change"):
            release.next_proxy_config(previous, previous, template.replace("root /srv/tblink-updates;", "root /other;"))

    def test_reject_missing_ip_override_method_or_extra_route(self):
        for candidate in [template.replace("        proxy_set_header X-Tblink-Client-IP $remote_addr;\n", "", 1),
                          template.replace("limit_except GET", "limit_except POST", 1),
                          template.replace("location = /v1/catalog", "location = /admin/orders")]:
            with self.assertRaises(RuntimeError):
                release.next_proxy_config(previous, previous, candidate)

    def test_reject_duplicate_and_missing_api(self):
        api = release.api_sections(template)[1]
        for candidate in [template + api, template.replace("server_name api.tuanbo-link.jinhefilm.com;", "server_name other.example.com;")]:
            with self.assertRaises(RuntimeError):
                release.next_proxy_config(previous, previous, candidate)

    def test_maintenance_only_changes_api(self):
        before, api, after = release.api_sections(release.maintenance_config(template))
        original_before, _, original_after = release.api_sections(template)
        self.assertEqual((before, after), (original_before, original_after))
        self.assertEqual(api.count("    return 503;\n"), 1)


class EnvironmentTest(unittest.TestCase):
    def test_preserve_unknown_fields_comments_and_line_endings(self):
        original = "# operator comment\r\nLICENSE_HOST=127.0.0.1\r\nCUSTOM_SETTING=preserve\r\nLICENSE_PROXY_MODE=none\r\n"
        result = release.proxy_environment(original)
        self.assertEqual(result, original.replace("LICENSE_PROXY_MODE=none", "LICENSE_PROXY_MODE=loopback"))
        self.assertEqual(release.proxy_environment(result), result)
        self.assertEqual(release.proxy_environment("CUSTOM_SETTING=value"), "CUSTOM_SETTING=value\nLICENSE_PROXY_MODE=loopback\n")

    def test_reject_ambiguous_or_unsafe_environment(self):
        for original in ["LICENSE_HOST=0.0.0.0\n", "ALIPAY_CHECKOUT_ENABLED=true\n", "LICENSE_PROXY_MODE=external\n",
                         "LICENSE_PROXY_MODE=none\nLICENSE_PROXY_MODE=loopback\n"]:
            with self.assertRaises(RuntimeError):
                release.proxy_environment(original)


class ActivationTest(unittest.TestCase):
    def exercise(self, catalog_ok, final_nginx_ok=True, renewal_table=True, payment_table=True):
        directory = Path(tempfile.mkdtemp(prefix="tblink-deploy-test-"))
        targets = {"/opt/tblink-licensing/dist/index.js": directory / "index.js",
                   "/opt/tblink-licensing/RELEASE": directory / "RELEASE",
                   "/etc/nginx/sites-available/tblink-licensing.conf": directory / "nginx.conf",
                   "/etc/tblink-licensing/service.env": directory / "service.env",
                   "/var/lib/tblink-licensing/license.db": directory / "license.db",
                   "/var/lib/tblink-licensing/backups": directory / "backups"}
        bundle = targets["/opt/tblink-licensing/dist/index.js"]
        nginx = targets["/etc/nginx/sites-available/tblink-licensing.conf"]
        environment = targets["/etc/tblink-licensing/service.env"]
        database = targets["/var/lib/tblink-licensing/license.db"]
        bundle.write_text("old code")
        nginx.write_text(previous)
        original_env = "# unchanged\nLICENSE_HOST=127.0.0.1\nALIPAY_CHECKOUT_ENABLED=false\nCUSTOM_SETTING=preserve\n"
        environment.write_text(original_env)
        os.chmod(environment, 0o640)
        targets["/opt/tblink-licensing/RELEASE"].write_text("a" * 40 + "\n")
        with closing(sqlite3.connect(database)) as db, db:
            db.executescript("CREATE TABLE orders (id TEXT); INSERT INTO orders VALUES ('retained'); CREATE TABLE order_delivery_access (id TEXT);")
        before = release.database_snapshot(database)
        archive = directory / "release.tar"
        with tarfile.open(archive, "x") as tar:
            for name, content in {"dist/index.js": "new code", "revision.txt": "b" * 40 + "\n", "nginx.previous.conf": previous, "nginx.next.conf": template}.items():
                data = content.encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        arguments = ["activate-release.py", str(archive), release.digest(archive), release.digest(bundle), release.digest(nginx), release.digest(environment)]
        calls = []
        checks = 0

        def command(*args):
            nonlocal checks
            calls.append(args)
            if args == ("nginx", "-t"):
                checks += 1
                if checks == 2 and not final_nginx_ok:
                    raise RuntimeError("simulated Nginx failure")
            if args == ("systemctl", "start", "tblink-licensing.service") and bundle.read_text() == "new code":
                self.assertIn("return 503;", nginx.read_text())
                self.assertIn("LICENSE_PROXY_MODE=loopback", environment.read_text())
                with closing(sqlite3.connect(database)) as db, db:
                    db.execute("CREATE TABLE IF NOT EXISTS purchase_requests (id TEXT)")
                    if renewal_table:
                        db.execute("CREATE TABLE IF NOT EXISTS license_renewals (id TEXT)")
                    if payment_table:
                        db.execute("CREATE TABLE IF NOT EXISTS payment_receipts (id TEXT)")

        def check_catalog():
            self.assertIn("return 503;", nginx.read_text())
            return catalog_ok

        original_mask = os.umask(0o077)
        try:
            with patch.object(release, "Path", side_effect=lambda value: targets.get(str(value), Path(value))), \
                 patch.object(release.os, "geteuid", return_value=0), patch.object(release, "run", side_effect=command), \
                 patch.object(release, "health", return_value=True), patch.object(release, "catalog_closed", side_effect=check_catalog), \
                 patch.object(release.sys, "argv", arguments), patch("builtins.print"):
                if catalog_ok and final_nginx_ok and renewal_table and payment_table:
                    release.main()
                else:
                    with self.assertRaises(RuntimeError):
                        release.main()
        finally:
            os.umask(original_mask)
        after = release.database_snapshot(database)
        self.assertTrue(all(after[name] == value for name, value in before.items()))
        self.assertIn("purchase_requests", after)
        self.assertEqual("license_renewals" in after, renewal_table)
        self.assertEqual("payment_receipts" in after, payment_table)
        self.assertEqual(environment.stat().st_mode & 0o777, 0o640)
        if catalog_ok and final_nginx_ok and renewal_table and payment_table:
            self.assertEqual(bundle.read_text(), "new code")
            self.assertEqual(nginx.read_text(), template)
            self.assertEqual(environment.read_text(), original_env + "LICENSE_PROXY_MODE=loopback\n")
            manifest = json.loads(next((directory / "backups").glob("*/manifest.json")).read_text())
            self.assertTrue(manifest["backupRestoreVerified"])
            self.assertTrue(manifest["catalogClosed"])
            self.assertEqual(targets["/opt/tblink-licensing/RELEASE"].read_text(), "b" * 40 + "\n")
        else:
            self.assertEqual(bundle.read_text(), "old code")
            self.assertEqual(nginx.read_text(), previous)
            self.assertEqual(environment.read_text(), original_env)
            self.assertEqual(targets["/opt/tblink-licensing/RELEASE"].read_text(), "a" * 40 + "\n")
        self.assertFalse(any(call[:2] == ("systemctl", "restart") for call in calls))
        self.assertFalse(any(call[:2] == ("systemctl", "stop") and call[2] != "tblink-licensing.service" for call in calls))

    def test_activate_with_maintenance_and_restore_verification(self):
        self.exercise(True)

    def test_restore_code_environment_proxy_when_catalog_is_open(self):
        self.exercise(False)

    def test_restore_after_final_nginx_validation_failure(self):
        self.exercise(True, False)

    def test_restore_when_renewal_migration_is_missing(self):
        self.exercise(True, renewal_table=False)

    def test_restore_when_payment_receipt_migration_is_missing(self):
        self.exercise(True, payment_table=False)


if __name__ == "__main__":
    unittest.main()
