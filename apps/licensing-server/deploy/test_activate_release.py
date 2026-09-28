import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("activate_release", Path(__file__).with_name("activate-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
template = Path(__file__).with_name("nginx.conf").read_text()
start = template.index("    # Customers need a dedicated delivery credential;")
end = template.index("    location / { return 404; }", start)
routes = template[start:end]


class ProxyUpgradeTest(unittest.TestCase):
    def test_initial_routes_and_second_upgrade_preserve_other_configuration(self):
        original = template[:start] + template[end:]
        self.assertEqual(release.next_proxy_config(original, routes), template)
        self.assertEqual(release.next_proxy_config(template, routes), template)

    def test_reject_partial_or_changed_routes(self):
        changed = template.replace("proxy_read_timeout 15s;", "proxy_read_timeout 20s;")
        with self.assertRaisesRegex(RuntimeError, "differ"):
            release.next_proxy_config(changed, routes)
        with self.assertRaisesRegex(RuntimeError, "differ"):
            release.next_proxy_config(template, routes + "    # extra\n")

    def test_reject_duplicate_or_misplaced_routes(self):
        with self.assertRaisesRegex(RuntimeError, "differ"):
            release.next_proxy_config(template[:end] + routes + template[end:], routes)
        with self.assertRaisesRegex(RuntimeError, "differ"):
            release.next_proxy_config(template + routes.replace('15s', '20s'), routes)
        moved = routes + template[:start] + template[end:]
        with self.assertRaisesRegex(RuntimeError, "differ"):
            release.next_proxy_config(moved, routes)

    def test_missing_api_and_empty_routes_fail(self):
        with self.assertRaises(ValueError):
            release.next_proxy_config("server_name other.example.com;", routes)
        with self.assertRaisesRegex(RuntimeError, "empty"):
            release.next_proxy_config(template[:start] + template[end:], "")


if __name__ == "__main__":
    unittest.main()
