#!/usr/bin/env python3
"""Export confirmed receipts from a read-only SQLite snapshot for later reconciliation."""
import argparse
from contextlib import closing
import csv
from datetime import date, datetime, time, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import time as clock


FIELDS = ('order_id', 'payment_reference', 'amount_fen', 'currency', 'source',
          'confirmed_at_utc', 'delivery_state')
CHINA = timezone(timedelta(hours=8))


def utc_boundary(value):
    return datetime.combine(value, time(), CHINA).astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def csv_value(value):
    if not isinstance(value, str):
        return value
    # CSV quoting alone does not prevent spreadsheet formulas or long-ID rounding.
    if value.lstrip().startswith(('=', '+', '-', '@')) or value.startswith(('\t', '\r', '\n')) or (value.isdecimal() and len(value) > 15):
        return "'" + value
    return value


def export_ledger(database, output, start, before, timeout=30):
    if start >= before:
        raise ValueError('from-date must be before before-date')
    deadline = clock.monotonic() + timeout
    started = datetime.now(timezone.utc).isoformat(timespec='milliseconds')
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
        db.execute('PRAGMA query_only=ON')
        db.set_progress_handler(lambda: int(clock.monotonic() >= deadline), 1000)
        db.execute('BEGIN')
        # This first read pins one snapshot, including legacy-coverage diagnostics.
        legacy_count = db.execute("SELECT count(*) FROM orders o WHERE o.state = 'fulfilled' AND NOT EXISTS (SELECT 1 FROM payment_receipts p WHERE p.order_id = o.id)").fetchone()[0]
        rows = db.execute('''SELECT p.order_id, p.payment_reference, p.amount_fen, p.source,
                             p.received_at, o.state
                             FROM payment_receipts p LEFT JOIN orders o ON o.id = p.order_id
                             WHERE p.received_at >= ? AND p.received_at < ?
                             ORDER BY p.received_at, p.order_id''', (utc_boundary(start), utc_boundary(before)))
        output.mkdir(mode=0o700)
        counts = {'alipay': 0, 'manual': 0}
        amounts = {'alipay': 0, 'manual': 0}
        states = {'pending': 0, 'fulfilled': 0}
        with (output / 'receipts.jsonl').open('x', encoding='utf-8') as exact, (output / 'receipts.csv').open('x', encoding='utf-8-sig', newline='') as sheet:
            os.chmod(exact.name, 0o600)
            os.chmod(sheet.name, 0o600)
            writer = csv.DictWriter(sheet, fieldnames=FIELDS)
            writer.writeheader()
            for order_id, reference, amount, source, confirmed, state in rows:
                if clock.monotonic() >= deadline:
                    raise TimeoutError('Export exceeded its time limit; bundle is incomplete')
                if source not in counts or state not in states or type(amount) is not int or amount <= 0:
                    raise ValueError('Receipt has invalid source, amount, or order state; bundle is incomplete')
                record = dict(zip(FIELDS, (order_id, reference, amount, 'CNY', source, confirmed, state)))
                exact.write(json.dumps(record, ensure_ascii=False) + '\n')
                writer.writerow({key: csv_value(value) for key, value in record.items()})
                counts[source] += 1
                amounts[source] += amount
                states[state] += 1
        summary = {
            'format_version': 1, 'complete': True, 'export_started_at_utc': started,
            'period_timezone': 'Asia/Shanghai', 'from_date_inclusive': start.isoformat(),
            'before_date_exclusive': before.isoformat(), 'selection_basis': 'local_payment_confirmation_time',
            'currency': 'CNY', 'receipt_count': sum(counts.values()), 'total_amount_fen': sum(amounts.values()),
            'count_by_source': counts, 'amount_fen_by_source': amounts, 'delivery_states': states,
            'fulfilled_orders_without_receipt_all_time': legacy_count,
            'scope': 'Internal confirmed receipts only; excludes channel fees, settlements, refunds, invoices, and tax recognition.',
            'csv_note': 'Potential formulas and numeric IDs longer than 15 digits have a leading apostrophe. JSONL preserves exact identifiers.'
        }
        # The summary is the completion marker; failures leave inspectable partial files.
        with (output / 'summary.json').open('x', encoding='utf-8') as result:
            os.chmod(result.name, 0o600)
            json.dump(summary, result, ensure_ascii=False, indent=2)
            result.write('\n')
        return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, default=Path('/var/lib/tblink-licensing/license.db'))
    parser.add_argument('--from-date', type=date.fromisoformat, required=True, help='Inclusive date in Asia/Shanghai')
    parser.add_argument('--before-date', type=date.fromisoformat, required=True, help='Exclusive date in Asia/Shanghai')
    parser.add_argument('--output-dir', type=Path, required=True, help='New private directory; existing paths are never overwritten')
    args = parser.parse_args()
    try:
        summary = export_ledger(args.database, args.output_dir, args.from_date, args.before_date)
    except (OSError, sqlite3.Error, ValueError, TimeoutError) as error:
        print(f'Export failed: {error}. Do not use a bundle without a complete summary.json.', file=sys.stderr)
        return 1
    print(json.dumps({'output_dir': str(args.output_dir), 'receipt_count': summary['receipt_count'],
                      'total_amount_fen': summary['total_amount_fen'],
                      'fulfilled_orders_without_receipt_all_time': summary['fulfilled_orders_without_receipt_all_time']}))
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    raise SystemExit(main())
