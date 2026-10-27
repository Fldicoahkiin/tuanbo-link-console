"""Keep the certificate the Tencent CDN serves for the update domain equal to the server's Let's Encrypt one.

Runs as root from tblink-cdn-certificate.timer once a day. certbot renews a certificate for the update domain
only (its HTTP-01 check passes through the CDN to this origin), so the key handed to Tencent covers nothing else;
the shared certificate for the API and website never leaves the server. This script compares the certificate the
CDN edge actually presents with that one and, only when they differ, uploads it to Tencent SSL and deploys it to
the CDN domain, then waits until the edge presents it. It also checks that the shared certificate the origin
serves is not about to expire, since its renewal goes through the CDN too. The result goes to a status file
without secrets, which console-health.py shows in the console.

  push-cdn-certificate.py                 check and deploy when needed (what the timer runs)
  push-cdn-certificate.py --edge HOST     talk to HOST (the CDN CNAME) instead of resolving the domain,
                                          for the first deployment before DNS points at the CDN
  push-cdn-certificate.py --check         compare only; never call the API, never write the status file
"""
import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import socket
import ssl
import sys
import time
import urllib.request

DOMAIN = 'updates.tuanbo-link.jinhefilm.com'
# The origin's public address. When the domain still resolves here, the CDN is not in front of it and there is
# nothing to compare.
ORIGIN_ADDRESS = '123.206.229.200'
LINEAGE = Path('/etc/letsencrypt/live/updates.tuanbo-link.jinhefilm.com')
# Nginx serves the shared certificate (API, website and the update domain at the origin) on this address.
SHARED_NAME = 'api.tuanbo-link.jinhefilm.com'
LOCAL_ORIGIN = '127.0.0.1'
CREDENTIALS = Path('/etc/tblink-cdn/credentials.json')
STATUS = Path('/var/lib/tblink-cdn/certificate-status.json')
API_HOST = 'ssl.tencentcloudapi.com'
API_VERSION = '2019-12-05'
API_TIMEOUT = 15
TLS_TIMEOUT = 10
# Let's Encrypt certificates are renewed with 30 days left; 14 days left means renewal has been failing.
WARN_DAYS = 14
DEPLOY_WAIT_SECONDS = 20 * 60
DEPLOY_POLL_SECONDS = 30
PEM_CERTIFICATE = re.compile(r'-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----', re.S)


def leaf_der(fullchain):
    match = PEM_CERTIFICATE.search(fullchain)
    if match is None:
        raise RuntimeError('fullchain.pem 里没有证书')
    return ssl.PEM_cert_to_DER_cert(match.group(0))


def fingerprint(der):
    return hashlib.sha256(der).hexdigest()


def tc3_authorization(secret_id, secret_key, service, host, action, payload, timestamp):
    """Tencent Cloud API v3 (TC3-HMAC-SHA256) Authorization header for a JSON POST to /."""
    date = datetime.fromtimestamp(timestamp, timezone.utc).strftime('%Y-%m-%d')
    signed_headers = 'content-type;host;x-tc-action'
    canonical_headers = f'content-type:application/json; charset=utf-8\nhost:{host}\nx-tc-action:{action.lower()}\n'
    canonical_request = '\n'.join(['POST', '/', '', canonical_headers, signed_headers, hashlib.sha256(payload).hexdigest()])
    scope = f'{date}/{service}/tc3_request'
    string_to_sign = '\n'.join(['TC3-HMAC-SHA256', str(timestamp), scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
    key = ('TC3' + secret_key).encode()
    for part in (date, service, 'tc3_request'):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return f'TC3-HMAC-SHA256 Credential={secret_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}'


def call_api(credentials, action, params, opener=urllib.request.urlopen, now=time.time):
    payload = json.dumps(params, separators=(',', ':')).encode()
    timestamp = int(now())
    request = urllib.request.Request('https://' + API_HOST + '/', data=payload, method='POST', headers={
        'Authorization': tc3_authorization(credentials['secretId'], credentials['secretKey'], 'ssl', API_HOST, action, payload, timestamp),
        'Content-Type': 'application/json; charset=utf-8',
        'Host': API_HOST,
        'X-TC-Action': action,
        'X-TC-Timestamp': str(timestamp),
        'X-TC-Version': API_VERSION,
    })
    with opener(request, timeout=API_TIMEOUT) as response:
        body = json.loads(response.read())
    result = body.get('Response') if isinstance(body, dict) else None
    if not isinstance(result, dict):
        raise RuntimeError(f'腾讯云 {action} 返回格式无效')
    error = result.get('Error')
    if error is not None:
        code = error.get('Code') if isinstance(error, dict) else None
        message = error.get('Message') if isinstance(error, dict) else None
        raise RuntimeError(f'腾讯云 {action} 失败：{code} {message}（RequestId {result.get("RequestId")}）')
    return result


def load_credentials(path, owner=0):
    try:
        info = path.stat()
    except FileNotFoundError:
        raise RuntimeError('缺少腾讯云凭据文件：' + str(path)) from None
    if info.st_uid != owner or info.st_mode & 0o077:
        raise RuntimeError('腾讯云凭据文件必须是 root 所有、权限 600：' + str(path))
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        raise RuntimeError('腾讯云凭据文件不是有效的 JSON：' + str(path)) from None
    if not isinstance(data, dict) or set(data) != {'secretId', 'secretKey'} or not all(isinstance(value, str) and value for value in data.values()):
        raise RuntimeError('腾讯云凭据文件只能有 secretId 和 secretKey 两项')
    return data


def resolve(host):
    return {info[4][0] for info in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)}


def served_certificate(host, name=DOMAIN):
    """The leaf certificate host presents for name, and its expiry when it also verifies (else None)."""
    try:
        with socket.create_connection((host, 443), timeout=TLS_TIMEOUT) as raw, \
                ssl.create_default_context().wrap_socket(raw, server_hostname=name) as tls:
            return tls.getpeercert(binary_form=True), ssl.cert_time_to_seconds(tls.getpeercert()['notAfter'])
    except ssl.SSLCertVerificationError:
        pass
    # An expired or mismatched certificate still has to be compared, so read it without verification.
    insecure = ssl.create_default_context()
    insecure.check_hostname = False
    insecure.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, 443), timeout=TLS_TIMEOUT) as raw, insecure.wrap_socket(raw, server_hostname=name) as tls:
        return tls.getpeercert(binary_form=True), None


def beijing_date(seconds):
    return datetime.fromtimestamp(seconds + 8 * 3600, timezone.utc).strftime('%Y-%m-%d')


def describe(not_after, now):
    days = int((not_after - now) // 86400)
    return f'到期 {beijing_date(not_after)}（剩 {days} 天）', days


def shared_certificate(fetch, now):
    """The shared certificate's remaining life; its renewal includes the update domain, so it goes through the CDN."""
    try:
        served = fetch(LOCAL_ORIGIN, SHARED_NAME)
    except OSError as error:
        raise RuntimeError(f'读不到服务器自己的证书（{type(error).__name__}: {error}）') from None
    if served[1] is None:
        raise RuntimeError('服务器的共用证书（API、官网）校验不通过（可能已过期）：certbot 续期可能失败')
    text, days = describe(served[1], now())
    if days < WARN_DAYS:
        raise RuntimeError(f'服务器的共用证书（API、官网）{text}：certbot 续期可能失败（续期要经过 CDN 回源到服务器）')
    return text


def sync(edge, check_only=False, **options):
    """Returns the success detail; raises RuntimeError with the reason otherwise."""
    detail = sync_cdn(edge, check_only, **options)
    shared = shared_certificate(options.get('fetch', served_certificate), options.get('now', time.time))
    return f'{detail}；服务器共用证书{shared}'


def sync_cdn(edge, check_only=False, lineage=LINEAGE, credentials_path=CREDENTIALS, owner=0, fetch=served_certificate,
             lookup=resolve, api=call_api, sleep=time.sleep, now=time.time):
    if edge == DOMAIN and ORIGIN_ADDRESS in lookup(DOMAIN):
        raise RuntimeError(f'{DOMAIN} 现在直接解析到服务器，没有经过 CDN；如果已经回退，请停用 tblink-cdn-certificate.timer')
    fullchain = (lineage / 'fullchain.pem').read_text()
    local = fingerprint(leaf_der(fullchain))
    try:
        served = fetch(edge)
    except OSError as error:
        served = None
        unreachable = f'连不上 CDN（{type(error).__name__}: {error}）'
    else:
        unreachable = None
    if served is not None and fingerprint(served[0]) == local:
        if served[1] is None:
            raise RuntimeError('CDN 上的证书与服务器一致，但校验不通过（可能已过期）：certbot 续期可能失败')
        text, days = describe(served[1], now())
        if days < WARN_DAYS:
            raise RuntimeError(f'CDN 证书与服务器一致，但{text}：certbot 续期可能失败（续期要经过 CDN 回源到服务器）')
        return f'CDN 证书与服务器一致，{text}'
    reason = unreachable or 'CDN 上的证书与服务器不一致'
    if check_only:
        raise RuntimeError(reason + '（--check 只比较，没有部署）')
    credentials = load_credentials(credentials_path, owner)
    upload = api(credentials, 'UploadCertificate', {
        'CertificatePublicKey': fullchain,
        'CertificatePrivateKey': (lineage / 'privkey.pem').read_text(),
        'CertificateType': 'SVR',
        'CertificateUse': 'CDN',
        'Alias': 'tblink-updates-' + local[:12],
        'Repeatable': False,
    })
    certificate = upload.get('CertificateId') or upload.get('RepeatCertId')
    if not isinstance(certificate, str) or not certificate:
        raise RuntimeError('腾讯云 UploadCertificate 没有返回证书 ID')
    deploy = api(credentials, 'DeployCertificateInstance', {
        'CertificateId': certificate,
        'InstanceIdList': [DOMAIN + '|on'],
        'ResourceType': 'cdn',
    })
    task = deploy.get('DeployRecordId')
    deadline = now() + DEPLOY_WAIT_SECONDS
    while True:
        sleep(DEPLOY_POLL_SECONDS)
        try:
            served = fetch(edge)
        except OSError:
            served = None
        if served is not None and fingerprint(served[0]) == local:
            if served[1] is None:
                raise RuntimeError(f'已部署证书 {certificate}（任务 {task}），但校验不通过（可能已过期）：certbot 续期可能失败')
            text, _ = describe(served[1], now())
            return f'{reason}，已部署服务器证书 {certificate}（任务 {task}），{text}'
        if now() >= deadline:
            raise RuntimeError(f'{reason}，已提交部署证书 {certificate}（任务 {task}），但 {DEPLOY_WAIT_SECONDS // 60} 分钟内 CDN 仍未换上')


def write_status(path, state, detail, now):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps({'state': state, 'checkedAt': datetime.fromtimestamp(now, timezone.utc).isoformat(), 'detail': detail}, ensure_ascii=False))
    temporary.chmod(0o644)
    os.replace(temporary, path)


def main(argv):
    parser = argparse.ArgumentParser(description='让 CDN 上的更新域名证书与服务器证书保持一致')
    parser.add_argument('--edge', default=DOMAIN, help='连接这个主机（CDN 的 CNAME）而不是解析域名')
    parser.add_argument('--check', action='store_true', help='只比较，不调用接口，不写状态文件')
    args = parser.parse_args(argv)
    try:
        detail = sync(args.edge, args.check)
    except Exception as error:  # Recorded for the console, printed for the journal, and the unit fails.
        if not args.check:
            write_status(STATUS, 'failed', str(error), time.time())
        print(str(error), file=sys.stderr)
        return 1
    if not args.check:
        write_status(STATUS, 'success', detail, time.time())
    print(detail)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
