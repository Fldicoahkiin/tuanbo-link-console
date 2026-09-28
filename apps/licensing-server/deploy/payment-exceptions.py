#!/usr/bin/env python3
"""Read pending delivery exceptions or explicitly retry one verified receipt on the server."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--token-file', type=Path, default=Path('/etc/tblink-licensing/admin-token.txt'))
    parser.add_argument('--after', type=int, default=0, help='Read one page of up to 100 exceptions after this cursor')
    parser.add_argument('--retry-order', type=uuid.UUID, help='Explicitly retry delivery of one already-confirmed payment; never charges or refunds')
    parser.add_argument('--reason', help='Required audit reason for --retry-order')
    args = parser.parse_args()
    if args.after < 0 or args.after > 9007199254740991:
        parser.error('--after is outside the supported cursor range')
    if args.retry_order and (not args.reason or not args.reason.strip() or len(args.reason.strip()) > 500):
        parser.error('--retry-order requires a reason of 1 to 500 characters')
    if args.reason and not args.retry_order:
        parser.error('--reason requires --retry-order')
    token = args.token_file.read_text().strip()
    if len(token) < 32 or '\n' in token or '\r' in token:
        raise RuntimeError('Invalid admin token file')
    path = f'/admin/orders/{args.retry_order}/retry-delivery' if args.retry_order else f'/admin/payment-exceptions?after={args.after}'
    body = json.dumps({'reason': args.reason.strip()}).encode() if args.retry_order else None
    request = urllib.request.Request('http://127.0.0.1:8787' + path, data=body,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    # Neither system proxy settings nor redirects may forward the administrator credential.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=12) as response:
            data = response.read(131073)
            if len(data) > 131072:
                raise RuntimeError('Response too large')
            print(json.dumps(json.loads(data), ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        with error:
            code = json.loads(error.read(4096)).get('code', 'HTTP_ERROR')
        print(json.dumps({'status': error.code, 'code': code}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    raise SystemExit(main())
