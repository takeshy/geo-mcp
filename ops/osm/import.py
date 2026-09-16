"""Full snapshot import. Stage first; publish via a transactional table swap."""
import sys
import json
import osmium
import psycopg

FIELDS = ['name', 'name:ja', 'amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'cuisine', 'brand', 'opening_hours']
FIELD_SET = set(FIELDS)
ADDRESS = ['addr:postcode', 'addr:prefecture', 'addr:city', 'addr:suburb', 'addr:neighbourhood', 'addr:block_number', 'addr:housenumber']

class Importer(osmium.SimpleHandler):
    def __init__(self, copy):
        super().__init__()
        self.copy = copy
        self.count = 0
        self.skipped = 0
        self.wkt = osmium.geom.WKTFactory()

    def save(self, obj, kind, identifier, geometry):
        tags = dict(obj.tags)
        # Include named stations/landmarks as well as all POI categories.
        if not any(tags.get(k) for k in FIELDS):
            return
        self.copy.write_row([kind, identifier, *[tags.get(k) for k in FIELDS], ''.join(tags.get(k, '') for k in ADDRESS), json.dumps(tags, ensure_ascii=False), geometry])
        self.count += 1
        if self.count % 100000 == 0:
            print(f'Extracted {self.count} objects; skipped {self.skipped} invalid geometries', flush=True)

    def relevant(self, obj):
        tags = obj.tags
        return bool(tags) and any(t.k in FIELD_SET and t.v for t in tags)

    def save_geometry(self, obj, kind, identifier, factory):
        try:
            geometry = factory(obj)
        except (RuntimeError, osmium.InvalidLocationError) as error:
            self.skipped += 1
            if self.skipped <= 10:
                print(f'Skipping invalid {kind}/{identifier}: {error}', file=sys.stderr, flush=True)
            return
        # Database/COPY errors must abort the snapshot; only geometry failures are skipped.
        self.save(obj, kind, identifier, geometry)

    def node(self, n):
        if self.relevant(n) and n.location.valid():
            self.save_geometry(n, 'node', n.id, self.wkt.create_point)

    def way(self, w):
        # Polygon ways are emitted as areas; linear named features remain searchable.
        if self.relevant(w) and not w.is_closed() and len(w.nodes) >= 2:
            self.save_geometry(w, 'way', w.id, self.wkt.create_linestring)

    def area(self, a):
        if self.relevant(a):
            self.save_geometry(a, 'way' if a.from_way() else 'relation', a.orig_id(), self.wkt.create_multipolygon)

def main():
    with psycopg.connect('') as db:
        db.execute('SELECT pg_advisory_lock(724102)')
        db.execute('DROP TABLE IF EXISTS places_next')
        db.execute('CREATE TABLE places_next (LIKE places INCLUDING ALL)')
        db.execute('CREATE TEMP TABLE poi_import (osm_type text, osm_id bigint, name text, name_ja text, amenity text, shop text, tourism text, leisure text, office text, healthcare text, cuisine text, brand text, opening_hours text, address text, tags jsonb, wkt text)')
        with db.cursor().copy('COPY poi_import FROM STDIN') as copy:
            handler = Importer(copy)
            handler.apply_file(sys.argv[1], locations=True, idx='sparse_file_array')
        if handler.count == 0:
            raise RuntimeError('Refusing to publish an empty OSM snapshot')
        db.execute('''INSERT INTO places_next (osm_type, osm_id, name, name_ja, amenity, shop, tourism, leisure, office, healthcare, cuisine, brand, opening_hours, address, tags, lat, lng, geom)
          SELECT osm_type, osm_id, name, name_ja, amenity, shop, tourism, leisure, office, healthcare, cuisine, brand, opening_hours, address, tags,
            ST_Y(p), ST_X(p), p::geography
          FROM (SELECT *, ST_PointOnSurface(ST_MakeValid(ST_GeomFromText(wkt,4326))) AS p FROM poi_import) s WHERE NOT ST_IsEmpty(p)
          ON CONFLICT (osm_type,osm_id) DO NOTHING''')
        db.execute('ANALYZE places_next')
        db.commit()
        if '--stage' not in sys.argv:
            db.execute('SET LOCAL lock_timeout = \'30s\'')
            db.execute('ALTER TABLE places RENAME TO places_previous')
            db.execute('ALTER TABLE places_next RENAME TO places')
            db.execute('DROP TABLE places_previous')
        print(f'Staged {handler.count} OSM objects; skipped {handler.skipped} invalid geometries', flush=True)


if __name__ == "__main__":
    main()
