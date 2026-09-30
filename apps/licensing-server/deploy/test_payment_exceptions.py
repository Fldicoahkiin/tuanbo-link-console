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

class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.state = Path(self.folder.name) / 'recovery.db'
        self.now = 1800000000
        self.items = []
        self.posts = []

    def receipt(self, number, **updates):
        from datetime import datetime, timezone
        item = {'cursor': number, 'orderId': f'12345678-1234-4234-8234-{number:012d}', 'source': 'alipay',
                'receivedAt': datetime.fromtimestamp(self.now - 120, timezone.utc).isoformat(),
                'lastError': 'INTERNAL_ERROR'}
        item.update(updates)
        self.items.append(item)
        return item

    def request(self, path, body=None):
        if body is None:
            after = int(path.rsplit('=', 1)[1])
            remaining = [item for item in self.items if item['cursor'] > after]
            page = remaining[:100]
            return {'items': page, 'nextCursor': page[-1]['cursor'] if len(page) == 100 else None}
        order_id = path.split('/')[3]
        self.posts.append((order_id, body))
        self.items = [item for item in self.items if item['orderId'] != order_id]
        return {'id': order_id, 'state': 'fulfilled'}

    def test_only_verified_channel_receipts_are_recovered(self):
        eligible = self.receipt(1)
        self.receipt(2, source='manual')
        self.receipt(3, lastError='RENEWAL_REVOKED')
        wechat = self.receipt(4, source='wechat')
        result = module.recover_batch(self.request, self.state, self.now)
        self.assertEqual(result, {'scanned': 4, 'attempted': 2, 'delivered': 2, 'deferred': 0, 'needsReview': 1, 'manualSkipped': 1})
        self.assertEqual([order for order, _ in self.posts], [eligible['orderId'], wechat['orderId']])
        self.assertIn('1/5', self.posts[0][1]['reason'])
        self.assertEqual(module.recover_batch(self.request, self.state, self.now + 3600)['attempted'], 0)

    def test_restart_preserves_backoff_and_five_attempt_budget(self):
        self.receipt(1)
        calls = []

        def failing(path, body=None):
            if body is None:
                return self.request(path)
            calls.append(body)
            raise module.AdminApiError(500, 'INTERNAL_ERROR')

        moment = self.now
        for attempt in range(1, 6):
            result = module.recover_batch(failing, self.state, moment)
            self.assertEqual(result['attempted'], 1)
            self.assertEqual(module.recover_batch(failing, self.state, moment + 1)['attempted'], 0)
            moment += 60 * 2 ** (attempt - 1)
        self.assertEqual(module.recover_batch(failing, self.state, moment + 86400)['attempted'], 0)
        self.assertEqual(len(calls), 5)
        with contextlib.closing(module.sqlite3.connect(self.state)) as db:
            self.assertEqual(db.execute('SELECT attempts, blocked FROM delivery_attempts').fetchone(), (5, 1))

    def test_lost_success_response_does_not_duplicate_delivery(self):
        self.receipt(1)

        def lost(path, body=None):
            result = self.request(path, body)
            if body is not None:
                raise module.AdminApiError(503, 'NETWORK_ERROR')
            return result

        self.assertEqual(module.recover_batch(lost, self.state, self.now)['deferred'], 1)
        self.assertEqual(module.recover_batch(lost, self.state, self.now + 3600)['attempted'], 0)
        self.assertEqual(len(self.posts), 1)

    def test_batch_limit_and_cursor_do_not_starve_later_orders(self):
        for number in range(1, 8):
            self.receipt(number)
        self.assertEqual(module.recover_batch(self.request, self.state, self.now)['delivered'], 5)
        self.assertEqual(module.recover_batch(self.request, self.state, self.now + 60)['delivered'], 2)
        self.assertEqual(module.recover_batch(self.request, self.state, self.now + 120)['attempted'], 0)
        self.assertEqual(len({order for order, _ in self.posts}), 7)

    def test_closed_or_revoked_order_and_bad_ack_need_manual_review(self):
        for failure in (module.AdminApiError(409, 'RENEWAL_REVOKED'), None):
            with self.subTest(failure=failure):
                state = Path(self.folder.name) / ('bad-ack.db' if failure is None else 'revoked.db')
                self.items = []
                self.receipt(1)
                count = []

                def rejected(path, body=None):
                    if body is None:
                        return self.request(path)
                    count.append(body)
                    if failure is not None:
                        raise failure
                    return {'id': 'another-order', 'state': 'fulfilled'}

                self.assertEqual(module.recover_batch(rejected, state, self.now)['needsReview'], 1)
                self.assertEqual(module.recover_batch(rejected, state, self.now + 3600)['attempted'], 0)
                self.assertEqual(len(count), 1)

    def test_fresh_receipts_wait_one_minute(self):
        from datetime import datetime, timezone
        self.receipt(1, receivedAt=datetime.fromtimestamp(self.now, timezone.utc).isoformat(), lastError=None)
        self.assertEqual(module.recover_batch(self.request, self.state, self.now + 59)['attempted'], 0)
        self.assertEqual(module.recover_batch(self.request, self.state, self.now + 60)['delivered'], 1)

    def test_network_failure_stops_batch_without_hammering_service(self):
        self.receipt(1)
        self.receipt(2)

        def disconnected(path, body=None):
            if body is None:
                return self.request(path)
            self.posts.append(body)
            raise module.AdminApiError(503, 'NETWORK_ERROR')

        self.assertEqual(module.recover_batch(disconnected, self.state, self.now)['attempted'], 1)
        self.assertEqual(len(self.posts), 1)

    def test_validate_entire_page_before_any_post(self):
        self.receipt(1)
        self.receipt(2, orderId='../../unpaid')
        with self.assertRaises(module.AdminApiError):
            module.recover_batch(self.request, self.state, self.now)
        self.assertEqual(self.posts, [])

    def test_refuse_main_database_and_preserve_its_permissions(self):
        with contextlib.closing(module.sqlite3.connect(self.state)) as db:
            db.execute('CREATE TABLE orders (id TEXT)')
        self.state.chmod(0o640)
        with self.assertRaisesRegex(RuntimeError, 'non-recovery'):
            module.recover_batch(self.request, self.state, self.now)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o640)

    def test_parallel_worker_stops_before_querying_orders(self):
        with self.state.with_suffix('.lock').open('a') as lock:
            module.fcntl.flock(lock, module.fcntl.LOCK_EX | module.fcntl.LOCK_NB)
            with patch.object(module, 'validated_page') as validate:
                with self.assertRaises(BlockingIOError):
                    module.recover_batch(self.request, self.state, self.now)
                validate.assert_not_called()
