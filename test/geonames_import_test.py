import importlib.util
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('geonames_import', Path(__file__).parents[1] / 'scripts/import-geonames.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImportTest(unittest.TestCase):
    def test_small_villages_retained_and_non_settlements_excluded(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / 'input.zip', Path(folder) / 'index.sqlite'
            rows = []
            for i, code in enumerate(['PPL', 'PPLA5', 'PPLX', 'PPLH', 'PPLQ', 'PPLW'], 1):
                rows.append('\t'.join([str(i), 'Village', '', '', '35', '139', 'P', code,
                                       'JP', '', '01', '', '', '', '0', '', '', '', '2026-01-01']))
            with zipfile.ZipFile(source, 'w') as archive:
                archive.writestr('allCountries.txt', '\n'.join(rows) + '\n')
            module.build(source, target)
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute('SELECT id FROM settlements ORDER BY id').fetchall(), [(1,), (2,)])
                self.assertEqual(db.execute('SELECT count(*) FROM settlement_spatial').fetchone()[0], 2)
                metadata = dict(db.execute('SELECT key,value FROM metadata'))
                self.assertEqual(metadata['license'], 'CC BY 4.0')
                self.assertEqual(len(metadata['source_sha256']), 64)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')


if __name__ == '__main__':
    unittest.main()
