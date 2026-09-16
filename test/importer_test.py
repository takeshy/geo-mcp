"""Run inside the osm-import image: python /tests/importer_test.py."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

path = Path('/import.py')
spec = importlib.util.spec_from_file_location('geo_importer', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ImporterTest(unittest.TestCase):
    def test_empty_tags_do_not_call_get(self):
        handler = module.Importer(None)
        self.assertFalse(handler.relevant(SimpleNamespace(tags=[])))
        self.assertTrue(handler.relevant(SimpleNamespace(tags=[SimpleNamespace(k='name', v='Station')])))
        self.assertFalse(handler.relevant(SimpleNamespace(tags=[SimpleNamespace(k='name', v='')])))

    def test_invalid_geometry_is_counted_and_skipped(self):
        handler = module.Importer(None)
        def invalid(_):
            raise RuntimeError('invalid area')
        handler.save_geometry(None, 'way', 395306496, invalid)
        self.assertEqual(handler.skipped, 1)
        self.assertEqual(handler.count, 0)

    def test_copy_errors_are_not_swallowed(self):
        handler = module.Importer(SimpleNamespace(write_row=lambda _: (_ for _ in ()).throw(RuntimeError('DB failure'))))
        obj = SimpleNamespace(tags={'name': 'Station'})
        with self.assertRaisesRegex(RuntimeError, 'DB failure'):
            handler.save_geometry(obj, 'node', 1, lambda _: 'POINT(139 35)')
        self.assertEqual(handler.skipped, 0)

unittest.main()
