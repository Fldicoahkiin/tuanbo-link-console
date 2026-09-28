import contextlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location('payment_exceptions', Path(__file__).with_name('payment-exceptions.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class DeliveryRecoveryIntegrationTest(unittest.TestCase):
    def test_signed_payment_delivery_failure_recovers_once_without_touching_unpaid_order(self):
        bundle = Path(__file__).resolve().parents[1] / 'dist' / 'index.js'
        self.assertTrue(bundle.is_file(), 'Build @tb/licensing-server before integration acceptance')
        with tempfile.TemporaryDirectory(prefix='tblink-delivery-recovery-') as folder:
            root = Path(folder)
            subprocess.run(['node', '-e', """
                const {generateKeyPairSync,randomBytes}=require('node:crypto');
                const {writeFileSync}=require('node:fs'); const {join}=require('node:path');
                const root=process.argv[1]; const write=(name,value)=>writeFileSync(join(root,name),value,{mode:0o600});
                const issuer=generateKeyPairSync('ed25519'), provider=generateKeyPairSync('rsa',{modulusLength:2048});
                write('signing.pem',issuer.privateKey.export({type:'pkcs8',format:'pem'}));
                write('provider-private.pem',provider.privateKey.export({type:'pkcs8',format:'pem'}));
                write('provider-public.pem',provider.publicKey.export({type:'spki',format:'pem'}));
                write('data-key',randomBytes(32).toString('base64')); write('admin-token',randomBytes(32).toString('hex'));
            """, str(root)], check=True, capture_output=True, timeout=15)
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            environment = dict(os.environ)
            for key in list(environment):
                if key.startswith(('LICENSE_', 'ALIPAY_')):
                    del environment[key]
            environment.update({
                'LICENSE_DATABASE': str(root / 'license.db'), 'LICENSE_PRIVATE_KEY_FILE': str(root / 'signing.pem'),
                'LICENSE_KEY_ID': 'isolated-recovery-test', 'LICENSE_DATA_KEY_FILE': str(root / 'data-key'),
                'LICENSE_ADMIN_TOKEN_FILE': str(root / 'admin-token'), 'LICENSE_HOST': '127.0.0.1', 'LICENSE_PORT': str(port),
                'ALIPAY_APP_ID': '2026000000000001', 'ALIPAY_SELLER_ID': '2088000000000001',
                'ALIPAY_PUBLIC_KEY_FILE': str(root / 'provider-public.pem'), 'ALIPAY_CHECKOUT_ENABLED': 'false'
            })
            token = (root / 'admin-token').read_text()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), recovery.NoRedirect())

            def request(path, body=None):
                req = urllib.request.Request(f'http://127.0.0.1:{port}' + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with opener.open(req, timeout=5) as response:
                    return json.load(response)

            with (root / 'server.log').open('w') as log:
                process = subprocess.Popen(['node', str(bundle)], env=environment, stdout=log, stderr=log)
                try:
                    ready = False
                    for _ in range(50):
                        self.assertIsNone(process.poll(), 'Isolated service exited before becoming ready')
                        try:
                            ready = request('/health') == {'status': 'ok'}
                        except urllib.error.URLError:
                            time.sleep(0.1)
                            continue
                        if ready:
                            break
                    self.assertTrue(ready, 'Isolated service did not become ready')
                    until = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                    body = {'reference': 'recovery-paid', 'customer': 'isolated test', 'customerType': 'company',
                            'quantity': 1, 'kind': 'subscription', 'amountFen': 100, 'useUntil': until, 'updatesUntil': until}
                    paid = request('/admin/orders', body)['id']
                    unpaid = request('/admin/orders', {**body, 'reference': 'recovery-unpaid'})['id']
                    with contextlib.closing(sqlite3.connect(root / 'license.db')) as database, database:
                        database.execute("CREATE TRIGGER fail_delivery BEFORE INSERT ON licenses BEGIN SELECT RAISE(ABORT, 'isolated delivery fault'); END")
                    fields = {'app_id': environment['ALIPAY_APP_ID'], 'seller_id': environment['ALIPAY_SELLER_ID'],
                              'out_trade_no': 'TB_' + paid.replace('-', ''), 'trade_no': '202609292200000000001234',
                              'charset': 'utf-8', 'notify_type': 'trade_status_sync', 'trade_status': 'TRADE_SUCCESS', 'total_amount': '1.00'}
                    signature = subprocess.run(['node', '-e', """
                        const {sign}=require('node:crypto'),{readFileSync}=require('node:fs');
                        const fields=JSON.parse(readFileSync(0,'utf8'));
                        const body=Object.keys(fields).sort().map(key=>key+'='+fields[key]).join('&');
                        process.stdout.write(sign('RSA-SHA256',Buffer.from(body),readFileSync(process.argv[1])).toString('base64'));
                    """, str(root / 'provider-private.pem')], input=json.dumps(fields), text=True, capture_output=True, check=True, timeout=5).stdout
                    notification = urllib.request.Request(f'http://127.0.0.1:{port}/v1/payments/alipay/notify',
                        data=urllib.parse.urlencode({**fields, 'sign_type': 'RSA2', 'sign': signature}).encode(),
                        headers={'Content-Type': 'application/x-www-form-urlencoded'})
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        opener.open(notification, timeout=5)
                    with failure.exception:
                        self.assertEqual(failure.exception.code, 500)
                    self.assertEqual(request('/admin/orders/' + paid)['state'], 'pending')
                    self.assertEqual(len(request('/admin/payment-exceptions')['items']), 1)
                    with contextlib.closing(sqlite3.connect(root / 'license.db')) as database, database:
                        database.execute('DROP TRIGGER fail_delivery')
                    state = root / 'recovery.db'
                    result = recovery.recover_batch(request, state, time.time() + 120)
                    self.assertEqual(result['delivered'], 1)
                    self.assertEqual(result['attempted'], 1)
                    delivered = request('/admin/orders/' + paid)
                    self.assertEqual(delivered['state'], 'fulfilled')
                    self.assertEqual(len(delivered['licenses']), 1)
                    self.assertEqual(recovery.recover_batch(request, state, time.time() + 240)['attempted'], 0)
                    self.assertEqual(request('/admin/orders/' + paid)['licenses'], delivered['licenses'])
                    self.assertEqual(request('/admin/orders/' + unpaid)['state'], 'pending')
                    self.assertEqual(request('/admin/payment-exceptions')['items'], [])
                finally:
                    process.terminate()
                    process.wait(timeout=10)
