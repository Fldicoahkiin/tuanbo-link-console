#!/usr/bin/env python3
"""Inspect delivery exceptions, explicitly retry one order, or recover verified Alipay receipts."""
import argparse
from contextlib import closing
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid


class AdminApiError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_client(token):
    # Neither redirects nor system proxy settings may forward this credential.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request('http://127.0.0.1:8787' + path, data=data,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with opener.open(request, timeout=12) as response:
                data = response.read(131073)
                if len(data) > 131072:
                    raise AdminApiError(502, 'INVALID_API_RESPONSE')
                return json.loads(data)
        except urllib.error.HTTPError as error:
            with error:
                try:
                    code = json.loads(error.read(4096)).get('code', 'HTTP_ERROR')
                except (ValueError, AttributeError):
                    code = 'HTTP_ERROR'
            if not isinstance(code, str) or not re.fullmatch(r'[A-Z0-9_]{1,80}', code):
                code = 'HTTP_ERROR'
            raise AdminApiError(error.code, code) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise AdminApiError(503, 'NETWORK_ERROR') from None
        except ValueError:
            raise AdminApiError(502, 'INVALID_API_RESPONSE') from None
    return request


def validated_page(value, after):
    if not isinstance(value, dict) or not isinstance(value.get('items'), list) or len(value['items']) > 100:
        raise AdminApiError(502, 'INVALID_EXCEPTION_PAGE')
    previous = after
    for item in value['items']:
        try:
            if (not isinstance(item, dict) or type(item['cursor']) is not int or item['cursor'] <= previous
                    or str(uuid.UUID(item['orderId'])) != item['orderId']
                    or item['source'] not in ('alipay', 'wechat', 'manual')
                    or item['lastError'] is not None and not isinstance(item['lastError'], str)):
                raise ValueError()
            received = datetime.fromisoformat(item['receivedAt'].replace('Z', '+00:00'))
            if received.tzinfo is None:
                raise ValueError()
            previous = item['cursor']
        except (KeyError, ValueError, TypeError, AttributeError):
            raise AdminApiError(502, 'INVALID_EXCEPTION_PAGE') from None
    next_cursor = value.get('nextCursor')
    if next_cursor is not None and (type(next_cursor) is not int or not value['items'] or next_cursor != previous):
        raise AdminApiError(502, 'INVALID_EXCEPTION_PAGE')
    return value['items'], next_cursor


def lapsed_orders(value):
    if not isinstance(value, dict) or not isinstance(value.get('items'), list) or len(value['items']) > 100:
        raise AdminApiError(502, 'INVALID_LAPSED_PAGE')
    for order_id in value['items']:
        try:
            if not isinstance(order_id, str) or str(uuid.UUID(order_id)) != order_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise AdminApiError(502, 'INVALID_LAPSED_PAGE') from None
    return value['items']


def expire_lapsed(request, db, now, result):
    """Query the channel for unpaid orders whose payment link lapsed; the service then closes, expires or delivers them."""
    for order_id in lapsed_orders(request('/admin/orders/lapsed-payment-links')):
        old = db.execute('SELECT attempts, next_at, blocked FROM expiry_attempts WHERE order_id=?', (order_id,)).fetchone()
        attempts, next_at, blocked = old or (0, 0, 0)
        if blocked or next_at > now:
            continue
        attempts += 1
        # Persist before the request, like delivery recovery: lost responses cannot reset the five-query budget.
        with db:
            db.execute('INSERT INTO expiry_attempts VALUES (?, ?, ?, 0, NULL) ON CONFLICT(order_id) DO UPDATE SET attempts=excluded.attempts, next_at=excluded.next_at',
                       (order_id, attempts, now + 300 * 2 ** (attempts - 1)))
        result['lapsedQueried'] += 1
        try:
            response = request(f'/admin/orders/{order_id}/reconcile', {})
            if not isinstance(response, dict) or response.get('id') != order_id or response.get('state') not in ('pending', 'paid', 'fulfilled', 'closed', 'expired'):
                raise AdminApiError(502, 'INVALID_RECONCILE_RESPONSE')
            if response['state'] == 'pending':
                # No channel verdict yet: retry with backoff, then leave it for an operator after five queries.
                with db:
                    db.execute('UPDATE expiry_attempts SET blocked=?, last_error=? WHERE order_id=?', (int(attempts >= 5), 'STILL_PENDING', order_id))
            else:
                result['lapsedSettled'] += 1
        except AdminApiError as error:
            blocked = attempts >= 5 or 400 <= error.status < 500 and error.status not in (408, 429) or error.code == 'INVALID_RECONCILE_RESPONSE'
            with db:
                db.execute('UPDATE expiry_attempts SET blocked=?, last_error=? WHERE order_id=?', (int(blocked), error.code, order_id))
            if error.code == 'NETWORK_ERROR':
                break
        if result['lapsedQueried'] >= 5:
            break


def recover_batch(request, state_path, now):
    """Only a persisted, verified payment can reach retry-delivery; lapsed unpaid orders are queried through the service, at most five per run."""
    state_path = Path(state_path)
    if state_path.is_symlink():
        raise RuntimeError('Recovery state must not be a symlink')
    lock_path = state_path.with_suffix('.lock')
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with closing(sqlite3.connect(state_path, timeout=1)) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if tables - {'delivery_attempts', 'recovery_cursor', 'expiry_attempts'}:
                raise RuntimeError('Refusing to use a non-recovery database')
            os.chmod(state_path, 0o600)
            db.executescript("""
                CREATE TABLE IF NOT EXISTS delivery_attempts
                  (order_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at REAL NOT NULL,
                   blocked INTEGER NOT NULL DEFAULT 0, last_error TEXT);
                CREATE TABLE IF NOT EXISTS expiry_attempts
                  (order_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at REAL NOT NULL,
                   blocked INTEGER NOT NULL DEFAULT 0, last_error TEXT);
                CREATE TABLE IF NOT EXISTS recovery_cursor (id INTEGER PRIMARY KEY CHECK(id=1), after_id INTEGER NOT NULL);
                INSERT OR IGNORE INTO recovery_cursor VALUES (1, 0);
            """)
            after = db.execute('SELECT after_id FROM recovery_cursor WHERE id=1').fetchone()[0]
            items, next_cursor = validated_page(request(f'/admin/payment-exceptions?after={after}'), after)
            result = {'scanned': 0, 'attempted': 0, 'delivered': 0, 'deferred': 0, 'needsReview': 0, 'manualSkipped': 0, 'lapsedQueried': 0, 'lapsedSettled': 0}
            error_code = None
            for index, item in enumerate(items):
                result['scanned'] += 1
                order_id = item['orderId']
                if item['source'] not in ('alipay', 'wechat'):
                    result['manualSkipped'] += 1
                    continue
                old = db.execute('SELECT attempts, next_at, blocked FROM delivery_attempts WHERE order_id=?', (order_id,)).fetchone()
                attempts, next_at, blocked = old or (0, 0, 0)
                if blocked or attempts >= 5 or item['lastError'] not in (None, 'INTERNAL_ERROR'):
                    result['needsReview'] += 1
                    with db:
                        db.execute('INSERT INTO delivery_attempts VALUES (?, ?, ?, 1, ?) ON CONFLICT(order_id) DO UPDATE SET blocked=1, last_error=excluded.last_error',
                                   (order_id, attempts, next_at, item['lastError']))
                    continue
                received = datetime.fromisoformat(item['receivedAt'].replace('Z', '+00:00')).timestamp()
                if next_at > now or received + 60 > now:
                    result['deferred'] += 1
                    continue
                attempts += 1
                # Persist before the request: restart/lost responses cannot reset the retry budget.
                with db:
                    db.execute('INSERT INTO delivery_attempts VALUES (?, ?, ?, 0, NULL) ON CONFLICT(order_id) DO UPDATE SET attempts=excluded.attempts, next_at=excluded.next_at',
                               (order_id, attempts, now + 60 * 2 ** (attempts - 1)))
                result['attempted'] += 1
                error_code = None
                try:
                    response = request(f'/admin/orders/{order_id}/retry-delivery', {'reason': f'自动恢复已核实渠道收款的交付，尝试 {attempts}/5'})
                    if not isinstance(response, dict) or response.get('id') != order_id or response.get('state') != 'fulfilled':
                        raise AdminApiError(502, 'INVALID_RETRY_RESPONSE')
                    result['delivered'] += 1
                    with db:
                        db.execute('UPDATE delivery_attempts SET last_error=NULL WHERE order_id=?', (order_id,))
                except AdminApiError as error:
                    error_code = error.code
                    blocked = attempts >= 5 or 400 <= error.status < 500 and error.status not in (408, 429) or error.code in ('INVALID_API_RESPONSE', 'INVALID_RETRY_RESPONSE')
                    result['needsReview' if blocked else 'deferred'] += 1
                    with db:
                        db.execute('UPDATE delivery_attempts SET blocked=?, last_error=? WHERE order_id=?', (int(blocked), error.code, order_id))
                if result['attempted'] >= 5 or error_code == 'NETWORK_ERROR':
                    if index + 1 < len(items):
                        next_cursor = item['cursor']
                    break
            with db:
                db.execute('UPDATE recovery_cursor SET after_id=? WHERE id=1', (next_cursor or 0,))
            if error_code != 'NETWORK_ERROR':
                expire_lapsed(request, db, now, result)
            return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--token-file', type=Path, default=Path('/etc/tblink-licensing/admin-token.txt'))
    parser.add_argument('--after', type=int, default=0, help='Read one page of up to 100 exceptions after this cursor')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--retry-order', type=uuid.UUID, help='Explicitly retry one confirmed payment; never charges or refunds')
    mode.add_argument('--recover-batch', action='store_true', help='Recover at most five verified Alipay receipts with a durable retry budget')
    parser.add_argument('--state-file', type=Path, default=Path('/var/lib/tblink-licensing/delivery-recovery.db'))
    parser.add_argument('--reason', help='Required audit reason for --retry-order')
    args = parser.parse_args()
    if args.after < 0 or args.after > 9007199254740991 or args.recover_batch and args.after:
        parser.error('--after is invalid for this mode')
    if args.retry_order and (not args.reason or not args.reason.strip() or len(args.reason.strip()) > 500):
        parser.error('--retry-order requires a reason of 1 to 500 characters')
    if args.reason and not args.retry_order:
        parser.error('--reason requires --retry-order')
    token = args.token_file.read_text().strip()
    if len(token) < 32 or '\n' in token or '\r' in token:
        raise RuntimeError('Invalid admin token file')
    request = api_client(token)
    try:
        if args.recover_batch:
            result = recover_batch(request, args.state_file, time.time())
        else:
            path = f'/admin/orders/{args.retry_order}/retry-delivery' if args.retry_order else f'/admin/payment-exceptions?after={args.after}'
            result = request(path, {'reason': args.reason.strip()} if args.retry_order else None)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except AdminApiError as error:
        print(json.dumps({'status': error.status, 'code': error.code}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    raise SystemExit(main())
