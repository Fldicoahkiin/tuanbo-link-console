from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('console_health', Path(__file__).with_name('console-health.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

NOW = datetime(2026, 11, 2, 4, 0, tzinfo=timezone.utc)


class CdnCertificateHealthTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.status = Path(self.temporary.name) / 'certificate-status.json'

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, content):
        self.status.write_text(content if isinstance(content, str) else json.dumps(content, ensure_ascii=False))

    def test_missing_status_means_not_installed(self):
        self.assertIsNone(module.cdn_certificate(self.status, NOW))

    def test_recent_result_is_shown_as_written(self):
        checked = (NOW - timedelta(hours=5)).isoformat()
        self.write({'state': 'success', 'checkedAt': checked, 'detail': 'CDN 证书与服务器一致，到期 2027-01-24（剩 83 天）'})
        self.assertEqual(module.cdn_certificate(self.status, NOW), ('cdn-certificate', 'success', checked, 'CDN 证书与服务器一致，到期 2027-01-24（剩 83 天）'))
        self.write({'state': 'failed', 'checkedAt': checked, 'detail': '连不上 CDN'})
        self.assertEqual(module.cdn_certificate(self.status, NOW)[1], 'failed')

    def test_stale_result_is_failed(self):
        checked = (NOW - timedelta(days=3)).isoformat()
        self.write({'state': 'success', 'checkedAt': checked, 'detail': 'CDN 证书与服务器一致'})
        row = module.cdn_certificate(self.status, NOW)
        self.assertEqual(row[1:3], ('failed', checked))
        self.assertIn('超过两天', row[3])

    def test_unreadable_status_is_failed(self):
        for content in ['{', '[]', {'state': 'ok', 'checkedAt': NOW.isoformat(), 'detail': 'x'},
                        {'state': 'success', 'checkedAt': 'yesterday', 'detail': 'x'},
                        {'state': 'success', 'checkedAt': '2026-11-02T03:00:00', 'detail': 'x'},
                        {'state': 'success', 'checkedAt': NOW.isoformat()}]:
            self.write(content)
            row = module.cdn_certificate(self.status, NOW)
            self.assertEqual((row[0], row[1]), ('cdn-certificate', 'failed'), content)


if __name__ == '__main__':
    unittest.main()
