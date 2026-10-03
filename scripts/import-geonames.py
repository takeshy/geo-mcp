#!/usr/bin/env python3
"""Build an offline settlement index from GeoNames allCountries.zip (CC BY 4.0)."""
import argparse
import hashlib
import io
import math
import os
from pathlib import Path
import sqlite3
import zipfile
from datetime import datetime, timezone


def build(source, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_suffix('.building.sqlite')
    if staging.exists():
        raise RuntimeError(f'Remove incomplete build before retrying: {staging}')
    db = sqlite3.connect(staging)
    db.executescript('''
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        CREATE TABLE settlements(id INTEGER PRIMARY KEY, name TEXT NOT NULL,
            country_code TEXT NOT NULL, admin1_code TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL);
        CREATE VIRTUAL TABLE settlement_spatial USING rtree(id,min_x,max_x,min_y,max_y,min_z,max_z);
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ''')
    # Exclude neighbourhoods (PPLX), historical/abandoned/destroyed places and
    # aggregates (PPLS), retaining inhabited towns, villages and admin seats.
    codes = {'PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLG', 'PPLL', 'PPLF', 'STLMT'}
    count = 0
    with zipfile.ZipFile(source) as archive:
        with archive.open('allCountries.txt') as raw:
            for line in io.TextIOWrapper(raw, encoding='utf-8'):
                fields = line.rstrip('\n').split('\t')
                if len(fields) != 19:
                    raise ValueError('Unexpected GeoNames row format')
                if fields[6] != 'P' or fields[7] not in codes:
                    continue
                lat, lng = float(fields[4]), float(fields[5])
                if not (-90 <= lat <= 90 and -180 <= lng <= 180) or not fields[1]:
                    raise ValueError('Invalid settlement')
                phi, theta = math.radians(lat), math.radians(lng)
                x, y, z = math.cos(phi)*math.cos(theta), math.cos(phi)*math.sin(theta), math.sin(phi)
                db.execute('INSERT INTO settlements VALUES(?,?,?,?,?,?)',
                           (int(fields[0]), fields[1], fields[8], fields[10], lat, lng))
                db.execute('INSERT INTO settlement_spatial VALUES(?,?,?,?,?,?,?)',
                           (int(fields[0]), x, x, y, y, z, z))
                count += 1
                if count % 100000 == 0:
                    db.commit()
                    print(f'{count:,} settlements', flush=True)
    if not count:
        raise ValueError('No settlements in source')
    with open(source, 'rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    db.executemany('INSERT INTO metadata VALUES(?,?)', {
        'source': 'https://download.geonames.org/export/dump/allCountries.zip',
        'license': 'CC BY 4.0', 'attribution': 'GeoNames',
        'built_at': datetime.now(timezone.utc).isoformat(),
        'source_sha256': checksum, 'count': str(count),
    }.items())
    db.commit()
    db.close()
    os.replace(staging, target)
    print(f'{count:,} settlements; {target.stat().st_size / 1024**2:.1f} MiB: {target}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='Downloaded allCountries.zip')
    parser.add_argument('target', nargs='?', default='data/geonames/settlements.sqlite')
    args = parser.parse_args()
    build(args.source, args.target)
