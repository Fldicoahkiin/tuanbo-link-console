from datetime import date
import csv
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('export_payment_ledger', Path(__file__).with_name('export-payment-ledger.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PaymentLedgerTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.database = self.root / 'license.db'
        self.output = self.root / 'export'
        self.db = sqlite3.connect(self.database)
        self.addCleanup(self.db.close)
        # Exercise the real service schema rather than a reduced export-only schema.
        source = (Path(__file__).parent.parent / 'src/service.ts').read_text()
        ddl = re.search(r'this\.db\.exec\(`(.*?)`\);', source, re.S).group(1)
        self.db.executescript(ddl)

    def add_receipt(self, order, reference, confirmed, amount=19900, state='fulfilled', source='alipay', receipt=True):
        self.db.execute('INSERT INTO orders VALUES (?, ?, ?, ?, ?)', (order, 'internal-' + order, '{"customer":"PRIVATE-CUSTOMER"}', state, reference if state == 'fulfilled' else None))
        if receipt:
            self.db.execute('INSERT INTO payment_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (order, reference, amount, source, 'PRIVATE-APP', 'PRIVATE-SELLER', confirmed, 'PRIVATE-ERROR'))
        self.db.commit()

    def export(self, **kwargs):
        return module.export_ledger(self.database, self.output, date(2026, 9, 28), date(2026, 9, 29), **kwargs)

    def test_china_day_boundaries_exact_money_pending_delivery_and_private_fields(self):
        self.add_receipt('prior', 'r0', '2026-09-27T15:59:59.999Z')
        self.add_receipt('first', '202609280000000000001', '2026-09-27T16:00:00.000Z', amount=19901)
        self.add_receipt('last', '=HYPERLINK("bad")', '2026-09-28T15:59:59.999Z', amount=199900, source='manual', state='pending')
        self.add_receipt('next', 'r3', '2026-09-28T16:00:00.000Z')
        before = list(self.db.iterdump())
        summary = self.export()
        self.assertEqual(summary['receipt_count'], 2)
        self.assertEqual(summary['total_amount_fen'], 219801)
        self.assertEqual(summary['delivery_states'], {'pending': 1, 'fulfilled': 1})
        self.assertEqual(summary['amount_fen_by_source'], {'alipay': 19901, 'wechat': 0, 'manual': 199900})
        records = [json.loads(line) for line in (self.output / 'receipts.jsonl').read_text().splitlines()]
        self.assertEqual([r['order_id'] for r in records], ['first', 'last'])
        self.assertEqual(records[1]['payment_reference'], '=HYPERLINK("bad")')
        with (self.output / 'receipts.csv').open(encoding='utf-8-sig', newline='') as stream:
            cells = list(csv.DictReader(stream))
        self.assertEqual(cells[0]['payment_reference'], "'202609280000000000001")
        self.assertEqual(cells[1]['payment_reference'], '\'=HYPERLINK("bad")')
        for file in self.output.iterdir():
            self.assertNotIn('PRIVATE-', file.read_text())
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(self.db.iterdump()), before)

    def test_wechat_receipts_are_exported_separately(self):
        self.add_receipt('wechat', 'wechat:4200000000000001', '2026-09-28T00:00:00.000Z', source='wechat', amount=80000)
        summary = self.export()
        self.assertEqual(summary['count_by_source'], {'alipay': 0, 'wechat': 1, 'manual': 0})
        self.assertEqual(summary['amount_fen_by_source'], {'alipay': 0, 'wechat': 80000, 'manual': 0})

    def test_empty_export_and_explicit_legacy_coverage_gap(self):
        self.add_receipt('old', 'r-old', '2026-09-27T16:00:00.000Z', receipt=False)
        summary = self.export()
        self.assertEqual(summary['receipt_count'], 0)
        self.assertEqual(summary['fulfilled_orders_without_receipt_all_time'], 1)
        self.assertEqual((self.output / 'receipts.jsonl').read_text(), '')
        self.assertTrue(json.loads((self.output / 'summary.json').read_text())['complete'])

    def test_existing_bundle_and_symlink_are_not_overwritten(self):
        self.export()
        original = (self.output / 'summary.json').read_bytes()
        with self.assertRaises(FileExistsError):
            self.export()
        self.assertEqual((self.output / 'summary.json').read_bytes(), original)
        link = self.root / 'link'
        link.symlink_to(self.output, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            module.export_ledger(self.database, link, date(2026, 9, 28), date(2026, 9, 29))

    def test_missing_database_not_created_and_reversed_period_rejected(self):
        missing = self.root / 'missing.db'
        with self.assertRaises(sqlite3.OperationalError):
            module.export_ledger(missing, self.output, date(2026, 9, 28), date(2026, 9, 29))
        self.assertFalse(missing.exists())
        with self.assertRaises(ValueError):
            module.export_ledger(self.database, self.output, date(2026, 9, 29), date(2026, 9, 28))
        self.assertFalse(self.output.exists())

    def test_invalid_receipt_cannot_produce_complete_bundle(self):
        self.add_receipt('bad', 'r', '2026-09-28T00:00:00.000Z', amount=0)
        with self.assertRaises(ValueError):
            self.export()
        self.assertFalse((self.output / 'summary.json').exists())

    def test_query_time_limit_is_enforced(self):
        self.add_receipt('one', 'r', '2026-09-28T00:00:00.000Z')
        with self.assertRaises((sqlite3.OperationalError, TimeoutError)):
            self.export(timeout=-1)
        self.assertFalse((self.output / 'summary.json').exists())

    def test_csv_formula_protection_for_whitespace_and_controls(self):
        for value in ['  =1+1', '\tSUM(A1)', '\r1', '\n1', '+42', '-42', '@x']:
            self.assertEqual(module.csv_value(value), "'" + value)
        self.assertEqual(module.csv_value(19900), 19900)
        self.assertEqual(module.csv_value('ordinary'), 'ordinary')

    def test_concurrent_receipt_waits_for_the_next_snapshot(self):
        self.add_receipt('first', 'r1', '2026-09-28T00:00:00.000Z')
        original_mkdir = Path.mkdir

        def mkdir_after_snapshot(path, *args, **kwargs):
            if path == self.output:
                self.add_receipt('later', 'r2', '2026-09-28T01:00:00.000Z')
            return original_mkdir(path, *args, **kwargs)

        with patch.object(Path, 'mkdir', mkdir_after_snapshot):
            summary = self.export()
        self.assertEqual(summary['receipt_count'], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM payment_receipts').fetchone()[0], 2)
        next_summary = module.export_ledger(self.database, self.root / 'next-export', date(2026, 9, 28), date(2026, 9, 29))
        self.assertEqual(next_summary['receipt_count'], 2)
