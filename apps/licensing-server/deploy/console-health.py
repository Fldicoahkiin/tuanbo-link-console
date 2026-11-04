"""Record actual recovery service status for the console; no credentials or API calls."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import subprocess

# Written once a day by push-cdn-certificate.py (root); absent until the CDN certificate sync is installed.
CDN_STATUS = Path('/var/lib/tblink-cdn/certificate-status.json')
UPSERT = 'INSERT INTO console_health VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,detail=excluded.detail'


def cdn_certificate(path, now):
    """The CDN certificate check as a console health row, or None when the sync is not installed."""
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        return ('cdn-certificate', 'failed', now.isoformat(), 'CDN 证书状态文件读不出来：' + type(error).__name__)
    if not isinstance(data, dict) or data.get('state') not in ('success', 'failed') or not all(isinstance(data.get(key), str) for key in ('checkedAt', 'detail')):
        return ('cdn-certificate', 'failed', now.isoformat(), 'CDN 证书状态文件格式无效')
    try:
        checked = datetime.fromisoformat(data['checkedAt'])
    except ValueError:
        return ('cdn-certificate', 'failed', now.isoformat(), 'CDN 证书状态文件格式无效')
    if checked.tzinfo is None or now - checked > timedelta(days=2):
        return ('cdn-certificate', 'failed', data['checkedAt'], '超过两天没有新的 CDN 证书检查：' + data['detail'])
    return ('cdn-certificate', data['state'], data['checkedAt'], data['detail'])


def record():
    result = subprocess.run(['systemctl', 'show', 'tblink-delivery-recovery.service', '--property=Result,ActiveState,ExecMainStatus,ExecMainExitTimestamp'], check=True, capture_output=True, text=True, timeout=10)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    state = 'unknown' if not fields.get('ExecMainExitTimestamp') else 'success' if fields.get('Result') == 'success' and fields.get('ExecMainStatus') == '0' else 'failed'
    now = datetime.now(timezone.utc)
    cdn = cdn_certificate(CDN_STATUS, now)
    with closing(sqlite3.connect('/var/lib/tblink-licensing/license.db', timeout=5)) as db, db:
        db.execute(UPSERT, ('delivery-recovery', state, now.isoformat(), '恢复任务状态：' + state + '；最近退出：' + fields.get('ExecMainExitTimestamp', '未知')))
        if cdn is not None:
            db.execute(UPSERT, cdn)


if __name__ == '__main__':
    record()
