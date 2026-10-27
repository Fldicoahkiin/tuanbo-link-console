import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('push_cdn_certificate', Path(__file__).with_name('push-cdn-certificate.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

DAY = 86400
NOW = 1_800_000_000


def pem(content):
    return '-----BEGIN CERTIFICATE-----\n' + base64.b64encode(content).decode() + '\n-----END CERTIFICATE-----\n'


LOCAL = pem(b'renewed leaf') + pem(b'intermediate')
LOCAL_DER = b'renewed leaf'
OLD_DER = b'previous leaf'


class Clock:
    def __init__(self):
        self.value = NOW
        self.sleeps = 0

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.sleeps += 1
        self.value += seconds


class Api:
    def __init__(self, upload=None):
        self.calls = []
        self.upload = upload or {'CertificateId': 'cert-new', 'RequestId': 'r1'}

    def __call__(self, credentials, action, params):
        self.calls.append((credentials, action, params))
        if action == 'UploadCertificate':
            return self.upload
        if action == 'DeployCertificateInstance':
            return {'DeployRecordId': 42, 'DeployStatus': 1, 'RequestId': 'r2'}
        raise AssertionError(action)


class Fetch:
    """Answers the CDN with the given (der, notAfter) results in order, repeating the last one; the origin's shared
    certificate with `shared`."""
    def __init__(self, *answers, shared=(b'shared leaf', NOW + 60 * DAY)):
        self.answers = list(answers)
        self.shared = shared
        self.edges = []

    def __call__(self, host, name=module.DOMAIN):
        if (host, name) == (module.LOCAL_ORIGIN, module.SHARED_NAME):
            answer = self.shared
        else:
            self.assertEqual(name, module.DOMAIN)
            self.edges.append(host)
            answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    @staticmethod
    def assertEqual(first, second):
        if first != second:
            raise AssertionError(f'{first!r} != {second!r}')


class PushCdnCertificateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.lineage = self.root / 'live'
        self.lineage.mkdir()
        (self.lineage / 'fullchain.pem').write_text(LOCAL)
        (self.lineage / 'privkey.pem').write_text('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n')
        self.credentials = self.root / 'credentials.json'
        self.credentials.write_text(json.dumps({'secretId': 'AKIDtest', 'secretKey': 'key-test'}))
        self.credentials.chmod(0o600)
        self.clock = Clock()

    def tearDown(self):
        self.temporary.cleanup()

    def sync(self, fetch, api=None, edge=module.DOMAIN, check_only=False, addresses=('203.0.113.7',)):
        return module.sync(edge, check_only, lineage=self.lineage, credentials_path=self.credentials, owner=os.getuid(),
                           fetch=fetch, lookup=lambda host: set(addresses), api=api or Api(), sleep=self.clock.sleep,
                           now=self.clock.now)

    def test_signature_matches_the_tencent_cloud_v3_example(self):
        # Example from the Tencent Cloud API v3 signing document: the published signature uses the masked key.
        payload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}'.encode()
        header = module.tc3_authorization('AKID' + '*' * 32, '*' * 32, 'cvm', 'cvm.tencentcloudapi.com', 'DescribeInstances', payload, 1551113065)
        self.assertEqual(header, 'TC3-HMAC-SHA256 Credential=AKID' + '*' * 32 + '/2019-02-25/cvm/tc3_request, '
                         'SignedHeaders=content-type;host;x-tc-action, '
                         'Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f')

    def test_api_call_signs_for_ssl_and_reports_errors_without_the_key(self):
        sent = []

        def opener(body):
            def open_request(request, timeout):
                sent.append((request, timeout))
                return io.BytesIO(json.dumps(body).encode())
            return open_request

        result = module.call_api({'secretId': 'AKIDtest', 'secretKey': 'key-test'}, 'UploadCertificate', {'Alias': 'x'},
                                 opener=opener({'Response': {'CertificateId': 'abc', 'RequestId': 'r'}}), now=lambda: NOW)
        self.assertEqual(result['CertificateId'], 'abc')
        request, timeout = sent[0]
        self.assertEqual((request.full_url, request.get_method(), timeout), ('https://ssl.tencentcloudapi.com/', 'POST', 15))
        self.assertEqual(request.get_header('X-tc-action'), 'UploadCertificate')
        self.assertEqual(request.get_header('X-tc-version'), '2019-12-05')
        self.assertEqual(request.get_header('X-tc-timestamp'), str(NOW))
        self.assertIn('/ssl/tc3_request', request.get_header('Authorization'))
        self.assertEqual(json.loads(request.data), {'Alias': 'x'})
        with self.assertRaises(RuntimeError) as failure:
            module.call_api({'secretId': 'AKIDtest', 'secretKey': 'key-test'}, 'DeployCertificateInstance', {},
                            opener=opener({'Response': {'Error': {'Code': 'AuthFailure', 'Message': 'denied'}, 'RequestId': 'r9'}}), now=lambda: NOW)
        self.assertIn('AuthFailure denied', str(failure.exception))
        self.assertIn('r9', str(failure.exception))
        self.assertNotIn('key-test', str(failure.exception))
        with self.assertRaises(RuntimeError):
            module.call_api({'secretId': 'a', 'secretKey': 'b'}, 'UploadCertificate', {}, opener=opener([]), now=lambda: NOW)

    def test_matching_certificate_needs_no_api_call(self):
        api = Api()
        detail = self.sync(Fetch((LOCAL_DER, NOW + 60 * DAY), shared=(b'shared leaf', NOW + 45 * DAY)), api)
        self.assertIn('一致', detail)
        self.assertIn('剩 60 天', detail)
        self.assertIn('服务器共用证书到期', detail)
        self.assertIn('剩 45 天', detail)
        self.assertEqual(api.calls, [])
        self.assertEqual(self.clock.sleeps, 0)

    def test_shared_certificate_close_to_expiry_or_unreadable_fails(self):
        for shared in [(b'shared leaf', NOW + 13 * DAY), (b'shared leaf', None), ConnectionRefusedError('refused')]:
            with self.assertRaises(RuntimeError) as failure:
                self.sync(Fetch((LOCAL_DER, NOW + 60 * DAY), shared=shared))
            self.assertIn('服务器', str(failure.exception))

    def test_matching_certificate_close_to_expiry_reports_failed_renewal(self):
        api = Api()
        with self.assertRaises(RuntimeError) as failure:
            self.sync(Fetch((LOCAL_DER, NOW + 10 * DAY)), api)
        self.assertIn('certbot', str(failure.exception))
        with self.assertRaises(RuntimeError):
            self.sync(Fetch((LOCAL_DER, None)), api)
        self.assertEqual(api.calls, [])

    def test_different_certificate_is_uploaded_deployed_and_confirmed(self):
        api = Api()
        fetch = Fetch((OLD_DER, NOW + 20 * DAY), (OLD_DER, NOW + 20 * DAY), (LOCAL_DER, NOW + 90 * DAY))
        detail = self.sync(fetch, api)
        self.assertIn('cert-new', detail)
        self.assertIn('任务 42', detail)
        self.assertEqual([call[1] for call in api.calls], ['UploadCertificate', 'DeployCertificateInstance'])
        credentials, _, upload = api.calls[0]
        self.assertEqual(credentials, {'secretId': 'AKIDtest', 'secretKey': 'key-test'})
        self.assertEqual(upload['CertificatePublicKey'], LOCAL)
        self.assertIn('secret', upload['CertificatePrivateKey'])
        self.assertEqual((upload['CertificateType'], upload['CertificateUse'], upload['Repeatable']), ('SVR', 'CDN', False))
        self.assertEqual(api.calls[1][2], {'CertificateId': 'cert-new', 'InstanceIdList': ['updates.tuanbo-link.jinhefilm.com|on'], 'ResourceType': 'cdn'})
        self.assertEqual(self.clock.sleeps, 2)

    def test_existing_upload_is_reused(self):
        api = Api({'CertificateId': '', 'RepeatCertId': 'cert-old', 'RequestId': 'r1'})
        self.sync(Fetch((OLD_DER, NOW + 20 * DAY), (LOCAL_DER, NOW + 90 * DAY)), api)
        self.assertEqual(api.calls[1][2]['CertificateId'], 'cert-old')
        with self.assertRaises(RuntimeError):
            self.sync(Fetch((OLD_DER, NOW + 20 * DAY)), Api({'RequestId': 'r1'}))

    def test_unreachable_edge_gets_the_certificate_deployed(self):
        api = Api()
        fetch = Fetch(ssl.SSLError('handshake failure'), (LOCAL_DER, NOW + 90 * DAY))
        detail = self.sync(fetch, api, edge='updates.tuanbo-link.jinhefilm.com.cdn.dnsv1.com')
        self.assertIn('连不上 CDN', detail)
        self.assertEqual(fetch.edges, ['updates.tuanbo-link.jinhefilm.com.cdn.dnsv1.com'] * 2)
        self.assertEqual(len(api.calls), 2)

    def test_deployment_that_never_appears_fails(self):
        with self.assertRaises(RuntimeError) as failure:
            self.sync(Fetch((OLD_DER, NOW + 20 * DAY)))
        self.assertIn('仍未换上', str(failure.exception))
        self.assertEqual(self.clock.sleeps, module.DEPLOY_WAIT_SECONDS // module.DEPLOY_POLL_SECONDS)

    def test_check_only_never_calls_the_api(self):
        api = Api()
        with self.assertRaises(RuntimeError) as failure:
            self.sync(Fetch((OLD_DER, NOW + 20 * DAY)), api, check_only=True)
        self.assertIn('--check', str(failure.exception))
        self.assertEqual(api.calls, [])

    def test_domain_still_pointing_at_the_origin_is_reported(self):
        fetch = Fetch((LOCAL_DER, NOW + 60 * DAY))
        with self.assertRaises(RuntimeError) as failure:
            self.sync(fetch, addresses=(module.ORIGIN_ADDRESS,))
        self.assertIn('tblink-cdn-certificate.timer', str(failure.exception))
        self.assertEqual(fetch.edges, [])
        # An explicit edge (the CDN CNAME before the DNS switch) skips the check.
        self.assertIn('一致', self.sync(fetch, edge='edge.example', addresses=(module.ORIGIN_ADDRESS,)))

    def test_credentials_must_be_private_and_complete(self):
        self.assertEqual(module.load_credentials(self.credentials, os.getuid())['secretId'], 'AKIDtest')
        self.credentials.chmod(0o640)
        with self.assertRaises(RuntimeError):
            module.load_credentials(self.credentials, os.getuid())
        self.credentials.chmod(0o600)
        with self.assertRaises(RuntimeError):
            module.load_credentials(self.credentials, os.getuid() + 1)
        for content in ['{"secretId": "a"}', '{"secretId": "a", "secretKey": ""}', '[]', 'not json']:
            self.credentials.write_text(content)
            with self.assertRaises(RuntimeError):
                module.load_credentials(self.credentials, os.getuid())
        with self.assertRaises(RuntimeError):
            module.load_credentials(self.root / 'missing.json', os.getuid())

    def test_leaf_is_the_first_certificate(self):
        self.assertEqual(module.leaf_der(LOCAL), LOCAL_DER)
        with self.assertRaises(RuntimeError):
            module.leaf_der('no certificate here')

    def test_status_file_is_replaced_whole(self):
        status = self.root / 'status.json'
        module.write_status(status, 'failed', '连不上 CDN', NOW)
        module.write_status(status, 'success', 'CDN 证书与服务器一致', NOW + 60)
        self.assertEqual(json.loads(status.read_text()), {'state': 'success', 'checkedAt': '2027-01-15T08:01:00+00:00', 'detail': 'CDN 证书与服务器一致'})
        self.assertEqual(status.stat().st_mode & 0o777, 0o644)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ['credentials.json', 'live', 'status.json'])


if __name__ == '__main__':
    unittest.main()
