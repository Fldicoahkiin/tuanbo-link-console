import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

spec = importlib.util.spec_from_file_location('payment_exceptions', Path(__file__).with_name('payment-exceptions.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PaymentExceptionCliTest(unittest.TestCase):
    def test_read_page_does_not_post_or_follow_redirects_or_system_proxy(self):
        self.run_cli(['--after', '17'], False)

    def test_retry_sends_only_order_and_explicit_audit_reason(self):
        self.run_cli(['--retry-order', '12345678-1234-4234-8234-123456789abc', '--reason', '核对故障后补发'], True)

    def run_cli(self, args, retry):
        observed = []

        class Opener:
            def open(self, request, timeout):
                observed.append(request)
                self.timeout = timeout
                return contextlib.closing(io.BytesIO(json.dumps({'id': 'test', 'state': 'fulfilled'} if retry else {'items': [], 'nextCursor': None}).encode()))

        def build(*handlers):
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], urllib.request.HTTPRedirectHandler)
            self.assertIsNone(handlers[1].redirect_request(None, None, 302, '', {}, 'https://other.invalid'))
            return Opener()

        with tempfile.TemporaryDirectory() as folder:
            token = Path(folder) / 'token'; token.write_text('a' * 48)
            output = io.StringIO()
            with patch.object(module.sys, 'argv', ['payment-exceptions.py', '--token-file', str(token), *args]), patch.object(module.urllib.request, 'build_opener', side_effect=build), contextlib.redirect_stdout(output):
                self.assertEqual(module.main(), 0)
            self.assertEqual(len(observed), 1)
            request = observed[0]
            self.assertEqual(request.get_method(), 'POST' if retry else 'GET')
            self.assertTrue(request.full_url.startswith('http://127.0.0.1:8787/admin/'))
            if retry:
                self.assertEqual(json.loads(request.data), {'reason': '核对故障后补发'})
            else:
                self.assertTrue(request.full_url.endswith('/payment-exceptions?after=17'))
                self.assertIsNone(request.data)
            self.assertNotIn('a' * 48, output.getvalue())

    def test_retry_without_reason_stops_before_reading_credentials(self):
        with patch.object(module.sys, 'argv', ['payment-exceptions.py', '--retry-order', '12345678-1234-4234-8234-123456789abc']), patch.object(Path, 'read_text') as read, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                module.main()
            read.assert_not_called()
