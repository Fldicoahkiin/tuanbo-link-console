import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('activate_catalog', Path(__file__).with_name('activate-catalog.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ENV = (b'# preserve operator note\r\nCUSTOM=value\r\nALIPAY_APP_ID=2021007101657826\r\n'
       b'ALIPAY_SELLER_ID=2088980148916563\r\nALIPAY_CHECKOUT_ENABLED=false # operator comment\r\n'
       b'ALIPAY_PRIVATE_KEY_FILE=/etc/tblink-licensing/private.pem\r\n'
       b'ALIPAY_PUBLIC_KEY_FILE=/etc/tblink-licensing/public.pem\r\n')
CLOSED = {'available': False, 'currency': 'CNY', 'termStart': 'fulfillment', 'offers': []}


class CatalogActivationTest(unittest.TestCase):
    def test_environment_preserves_comments_unknown_values_and_line_endings(self):
        changed, _ = module.sales_environment(ENV)
        self.assertEqual(changed, ENV.replace(b'ENABLED=false', b'ENABLED=true') + b'LICENSE_CATALOG_FILE=/etc/tblink-licensing/catalog.json\r\n')

    def test_rejects_active_duplicate_and_wrong_company_settings(self):
        for raw in [ENV.replace(b'ENABLED=false', b'ENABLED=true'), ENV + b'CUSTOM=other\n',
                    ENV.replace(b'2088980148916563', b'2088452891335703'), ENV + b'LICENSE_CATALOG_FILE=/other\n']:
            with self.assertRaises(RuntimeError):
                module.sales_environment(raw)

    def exercise(self, success, unsafe_backups=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / 'etc/tblink-licensing'
            config.mkdir(parents=True)
            backups = root / module.BACKUPS
            backups.mkdir(parents=True)
            for path in [root / 'var', root / 'var/backups', backups]:
                path.chmod(0o755)
            if unsafe_backups:
                (root / 'var/backups').chmod(0o777)
            environment = config / 'service.env'
            environment.write_bytes(ENV)
            os.chmod(environment, 0o600)
            for name in ['private.pem', 'public.pem']:
                (config / name).write_text('test-only-key')
            source = Path(__file__).with_name('catalog.json')
            catalog = json.loads(source.read_text())
            opened = {**CLOSED, 'available': True, 'offers': catalog['offers']}
            answers = [CLOSED, opened] if success else [CLOSED, {**opened, 'offers': []}, CLOSED]
            user = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            with patch.object(module.pwd, 'getpwnam', return_value=user), patch.object(module, 'restart') as restart, \
                    patch.object(module, 'read_catalog', side_effect=answers), patch.object(module, 'ROOT_UID', os.getuid()):
                if unsafe_backups:
                    with self.assertRaisesRegex(RuntimeError, 'root-only'):
                        module.activate(source, module.digest(source.read_bytes()), module.digest(ENV), root)
                    restart.assert_not_called()
                    self.assertEqual(environment.read_bytes(), ENV)
                    self.assertFalse((config / 'catalog.json').exists())
                    self.assertEqual(list(backups.iterdir()), [])
                    return
                if success:
                    result = module.activate(source, module.digest(source.read_bytes()), module.digest(ENV), root)
                    self.assertTrue(result['salesEnabled'])
                    self.assertEqual((config / 'catalog.json').read_bytes(), source.read_bytes())
                    self.assertEqual((config / 'catalog.json').stat().st_mode & 0o777, 0o600)
                    self.assertEqual(restart.call_count, 1)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'differs'):
                        module.activate(source, module.digest(source.read_bytes()), module.digest(ENV), root)
                    self.assertEqual(environment.read_bytes(), ENV)
                    self.assertFalse((config / 'catalog.json').exists())
                    self.assertEqual(restart.call_count, 2)
            backup = next(backups.iterdir())
            self.assertEqual((backup / 'previous-environment').read_bytes(), ENV)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o700)

    def test_opens_reviewed_catalog_without_changing_other_environment(self):
        self.exercise(True)

    def test_failed_health_check_restores_closed_sales(self):
        self.exercise(False)

    def test_refuses_to_start_when_the_backup_directory_is_not_root_only(self):
        self.exercise(True, unsafe_backups=True)

    def test_wrong_catalog_digest_stops_before_reading_production(self):
        with patch.object(module, 'read_catalog') as health:
            with self.assertRaisesRegex(RuntimeError, 'reviewed content'):
                module.activate(Path(__file__).with_name('catalog.json'), 'wrong', 'unused')
            health.assert_not_called()
