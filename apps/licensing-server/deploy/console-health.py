"""Record actual recovery service status for the console; no credentials or API calls."""
from contextlib import closing
from datetime import datetime, timezone
import sqlite3
import subprocess


def record():
    result = subprocess.run(['systemctl', 'show', 'tblink-delivery-recovery.service', '--property=Result,ActiveState,ExecMainStatus,ExecMainExitTimestamp'], check=True, capture_output=True, text=True, timeout=10)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    state = 'unknown' if not fields.get('ExecMainExitTimestamp') else 'success' if fields.get('Result') == 'success' and fields.get('ExecMainStatus') == '0' else 'failed'
    with closing(sqlite3.connect('/var/lib/tblink-licensing/license.db', timeout=5)) as db, db:
        db.execute('INSERT INTO console_health VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,detail=excluded.detail', ('delivery-recovery', state, datetime.now(timezone.utc).isoformat(), '恢复任务状态：' + state + '；最近退出：' + fields.get('ExecMainExitTimestamp', '未知')))


if __name__ == '__main__':
    record()
