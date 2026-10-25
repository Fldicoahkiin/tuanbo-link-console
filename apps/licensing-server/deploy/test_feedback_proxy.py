import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("feedback_proxy", HERE / "feedback-proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
template = (HERE / "nginx.conf").read_text()
site = (HERE / "purchase-site.conf").read_text()
site = site[site.index("server {"):]


def strip_feedback(config):
    config = re.sub(r"# In-app problem reports: a report.*?\nlimit_req_zone [^\n]*tblink_feedback[^\n]*\n", "", config, flags=re.S)
    return re.sub(r"    # In-app problem reports\..*?\n(    location / \{ return 404; \}\n)", r"\1", config, count=1, flags=re.S)


def live(config):
    """The template with the website block as installed in production."""
    website = proxy.load("publish_website", "publish-website.py")
    before, _, after = website.site_sections(config)
    return before + site + after


class FeedbackProxyTest(unittest.TestCase):
    def test_adds_exactly_the_template_routes_to_the_live_config(self):
        current = live(strip_feedback(template))
        self.assertNotIn("feedback", current)
        candidate = proxy.add_feedback(current, template)
        self.assertEqual(candidate, live(template))
        self.assertEqual(strip_feedback(candidate), current)

    def test_refuses_twice_or_an_unexpected_layout(self):
        with self.assertRaisesRegex(RuntimeError, "already present"):
            proxy.add_feedback(live(template), template)
        current = live(strip_feedback(template))
        with self.assertRaisesRegex(RuntimeError, "activation rate-limit zone"):
            proxy.add_feedback(current.replace(proxy.ACTIVATION_ZONE, ""), template)
        # A live file that later deployments would already reject is not patched either.
        with self.assertRaises(RuntimeError):
            proxy.add_feedback(current.replace("location = /v1/catalog", "location = /admin/orders", 1), template)

    def test_command_writes_the_candidate_and_prints_its_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            current = Path(folder, "current.conf")
            current.write_text(live(strip_feedback(template)))
            output = Path(folder, "candidate.conf")
            result = subprocess.run([sys.executable, str(HERE / "feedback-proxy.py"), str(current), str(HERE / "nginx.conf"), str(output)],
                                    check=True, capture_output=True, text=True, timeout=30)
            self.assertEqual(output.read_text(), live(template))
            self.assertRegex(result.stdout, r"sha256 [a-f0-9]{64}")


if __name__ == "__main__":
    unittest.main()
