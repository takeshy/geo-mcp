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


def build(source, target, alternate_names=None):
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
            country_code TEXT NOT NULL, admin1_code TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
            name_ja TEXT, name_en TEXT, admin2_code TEXT, admin3_code TEXT, admin4_code TEXT);
        CREATE TABLE administrative_areas(id INTEGER PRIMARY KEY, level INTEGER NOT NULL,
            country_code TEXT NOT NULL, admin1_code TEXT NOT NULL, admin2_code TEXT NOT NULL,
            admin3_code TEXT NOT NULL, admin4_code TEXT NOT NULL, name TEXT NOT NULL, name_ja TEXT, name_en TEXT);
        CREATE INDEX administrative_codes ON administrative_areas(country_code,level,admin1_code,admin2_code,admin3_code,admin4_code);
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
                if fields[6] == 'A' and fields[7] in {'ADM1', 'ADM2', 'ADM3', 'ADM4'}:
                    level = int(fields[7][-1])
                    codes_path = [fields[10 + i] if i < level else '' for i in range(4)]
                    db.execute('INSERT INTO administrative_areas(id,level,country_code,admin1_code,admin2_code,admin3_code,admin4_code,name) VALUES(?,?,?,?,?,?,?,?)',
                               (int(fields[0]), level, fields[8], *codes_path, fields[1]))
                    continue
                if fields[6] != 'P' or fields[7] not in codes:
                    continue
                lat, lng = float(fields[4]), float(fields[5])
                if not (-90 <= lat <= 90 and -180 <= lng <= 180) or not fields[1]:
                    raise ValueError('Invalid settlement')
                phi, theta = math.radians(lat), math.radians(lng)
                x, y, z = math.cos(phi)*math.cos(theta), math.cos(phi)*math.sin(theta), math.sin(phi)
                db.execute('INSERT INTO settlements(id,name,country_code,admin1_code,lat,lng,admin2_code,admin3_code,admin4_code) VALUES(?,?,?,?,?,?,?,?,?)',
                           (int(fields[0]), fields[1], fields[8], fields[10], lat, lng, *fields[11:14]))
                db.execute('INSERT INTO settlement_spatial VALUES(?,?,?,?,?,?,?)',
                           (int(fields[0]), x, x, y, y, z, z))
                count += 1
                if count % 100000 == 0:
                    db.commit()
                    print(f'{count:,} settlements', flush=True)
    if not count:
        raise ValueError('No settlements in source')
    if alternate_names is not None:
        # Keep only the Japanese and English display names needed by the offline lookup.
        # Preferred names win, then non-colloquial/full names, then stable ID.
        selected = {}
        with zipfile.ZipFile(alternate_names) as archive:
            with archive.open('alternateNamesV2.txt') as raw:
                for line in io.TextIOWrapper(raw, encoding='utf-8'):
                    fields = line.rstrip('\r\n').split('\t')
                    if len(fields) != 10:
                        raise ValueError('Unexpected GeoNames alternate name row format')
                    if fields[2] not in {'ja', 'en'} or fields[7] == '1' or not fields[3].strip():
                        continue
                    geoname_id = int(fields[1])
                    if db.execute('SELECT 1 FROM settlements WHERE id=? UNION ALL SELECT 1 FROM administrative_areas WHERE id=?',
                                  (geoname_id, geoname_id)).fetchone() is None:
                        continue
                    rank = (fields[4] != '1', fields[6] == '1', fields[5] == '1', int(fields[0]))
                    key = (geoname_id, fields[2])
                    if key not in selected or rank < selected[key][0]:
                        selected[key] = (rank, fields[3].strip())
        for language in ('ja', 'en'):
            for table in ('settlements', 'administrative_areas'):
                db.executemany(f'UPDATE {table} SET name_{language}=? WHERE id=?',
                               ((name, geoname_id) for (geoname_id, lang), (_, name) in selected.items()
                                if lang == language))
        with open(alternate_names, 'rb') as stream:
            alternate_checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        db.executemany('INSERT INTO metadata VALUES(?,?)', {
            'alternate_names_source': 'https://download.geonames.org/export/dump/alternateNamesV2.zip',
            'alternate_names_sha256': alternate_checksum,
            'japanese_name_count': str(sum(lang == 'ja' for _, lang in selected)),
            'english_name_count': str(sum(lang == 'en' for _, lang in selected)),
        }.items())
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
    parser.add_argument('--alternate-names', required=True, help='Downloaded alternateNamesV2.zip')
    args = parser.parse_args()
    build(args.source, args.target, args.alternate_names)
