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
            rows.append('\t'.join(['100', 'City', '', '', '35', '139', 'A', 'ADM2',
                                         'JP', '', '01', 'city', '', '', '0', '', '', '', '2026-01-01']))
            with zipfile.ZipFile(source, 'w') as archive:
                archive.writestr('allCountries.txt', '\n'.join(rows) + '\n')
            alternate = Path(folder) / 'alternate.zip'
            names = [
                ['18', '100', 'ja', '横浜市', '1', '', '', '', '', ''],
                ['19', '100', 'en', 'Yokohama', '1', '', '', '', '', ''],
                ['10', '1', 'ja', '旧名', '1', '', '', '1', '', ''],
                ['11', '1', 'en', 'English', '1', '', '', '', '', ''],
                ['12', '1', 'ja', '通称', '', '', '1', '', '', ''],
                ['13', '1', 'ja', '通常名', '', '', '', '', '', ''],
                ['15', '1', 'ja', '別の正式名', '1', '', '', '', '', ''],
                ['14', '1', 'ja', '大豆戸町', '1', '', '', '', '', ''],
                ['16', '2', 'ja', '   ', '1', '', '', '', '', ''],
                ['17', '3', 'ja', '除外された地区', '1', '', '', '', '', ''],
            ]
            with zipfile.ZipFile(alternate, 'w') as archive:
                archive.writestr('alternateNamesV2.txt', '\n'.join('\t'.join(row) for row in names) + '\n')
            module.build(source, target, alternate)
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute('SELECT id FROM settlements ORDER BY id').fetchall(), [(1,), (2,)])
                self.assertEqual(db.execute('SELECT count(*) FROM settlement_spatial').fetchone()[0], 2)
                metadata = dict(db.execute('SELECT key,value FROM metadata'))
                self.assertEqual(metadata['license'], 'CC BY 4.0')
                self.assertEqual(db.execute('SELECT name,name_ja,name_en FROM settlements ORDER BY id').fetchall(),
                                 [('Village', '大豆戸町', 'English'), ('Village', None, None)])
                self.assertEqual(db.execute('SELECT level,name_ja,name_en FROM administrative_areas').fetchall(),
                                 [(2, '横浜市', 'Yokohama')])
                self.assertEqual(metadata['japanese_name_count'], '2')
                self.assertEqual(metadata['english_name_count'], '2')
                self.assertEqual(len(metadata['alternate_names_sha256']), 64)
                self.assertEqual(len(metadata['source_sha256']), 64)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')


if __name__ == '__main__':
    unittest.main()
