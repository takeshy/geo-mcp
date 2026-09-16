"""Portable POI snapshot builder, shared by the initial export and weekly PBF job."""
import json
try:
    import pysqlite3 as sqlite3
except ImportError:
    import sqlite3
from pathlib import Path

COLUMNS = ['osm_type', 'osm_id', 'name', 'name_ja', 'amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'cuisine', 'brand', 'opening_hours', 'address', 'lat', 'lng']

class Snapshot:
    def __init__(self, path):
        if Path(path).exists():
            raise ValueError('Snapshot destination must be new')
        self.db = sqlite3.connect(path)
        self.db.executescript('''
          PRAGMA journal_mode=OFF;
          PRAGMA synchronous=OFF;
          CREATE TABLE places (id INTEGER PRIMARY KEY, osm_type TEXT NOT NULL, osm_id INTEGER NOT NULL,
            name TEXT, name_ja TEXT, amenity TEXT, shop TEXT, tourism TEXT, leisure TEXT, office TEXT,
            healthcare TEXT, cuisine TEXT, brand TEXT, opening_hours TEXT, address TEXT,
            lat REAL NOT NULL, lng REAL NOT NULL, search_name TEXT NOT NULL, UNIQUE(osm_type, osm_id));
          CREATE VIRTUAL TABLE places_spatial USING rtree(id, min_lat, max_lat, min_lng, max_lng);
          CREATE VIRTUAL TABLE places_names USING fts5(search_name, content='places', content_rowid='id', tokenize='trigram');
        ''')
        self.count = 0

    def add(self, row):
        search = '\n'.join(str(row.get(k) or '') for k in ['name', 'name_ja', 'brand']).lower()
        cursor = self.db.execute('INSERT OR IGNORE INTO places (' + ','.join(COLUMNS) + ',search_name) VALUES (' + ','.join('?' for _ in range(len(COLUMNS)+1)) + ')', [row.get(k) for k in COLUMNS] + [search])
        if cursor.rowcount:
            self.db.execute('INSERT INTO places_spatial VALUES (?,?,?,?,?)', [cursor.lastrowid, row['lat'], row['lat'], row['lng'], row['lng']])
            self.count += 1
        if self.count % 10000 == 0:
            self.db.commit()

    def finish(self):
        if not self.count:
            raise ValueError('Refusing to publish empty snapshot')
        self.db.execute("INSERT INTO places_names(places_names) VALUES ('rebuild')")
        self.db.execute("INSERT INTO places_names(places_names) VALUES ('optimize')")
        self.db.execute('ANALYZE')
        self.db.commit()
        result = self.db.execute('PRAGMA integrity_check').fetchone()[0]
        if result != 'ok':
            raise ValueError(result)
        self.db.close()
        return self.count

if __name__ == '__main__':
    import sys
    snapshot = Snapshot(sys.argv[1])
    for line in sys.stdin:
        snapshot.add(json.loads(line))
    print(json.dumps({'places': snapshot.finish(), 'path': sys.argv[1]}))
