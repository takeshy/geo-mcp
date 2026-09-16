"""Extract POIs without a database service; publish only a completed SQLite file."""
import sys
import json
import osmium
from shapely import wkt, make_valid
from snapshot import Snapshot

FIELDS = ['name','name:ja','amenity','shop','tourism','leisure','office','healthcare','cuisine','brand','opening_hours']
ADDRESS = ['addr:postcode','addr:prefecture','addr:city','addr:suburb','addr:neighbourhood','addr:block_number','addr:housenumber']
class Extractor(osmium.SimpleHandler):
    def __init__(self, snapshot):
        super().__init__()
        self.snapshot = snapshot
        self.factory = osmium.geom.WKTFactory()
        self.skipped = 0
    def relevant(self, obj):
        return bool(obj.tags) and any(t.k in FIELDS and t.v for t in obj.tags)
    def save(self, obj, kind, identifier, geometry):
        try:
            point = make_valid(wkt.loads(geometry(obj))).representative_point()
            if point.is_empty:
                self.skipped += 1
                return
        except (RuntimeError, osmium.InvalidLocationError):
            self.skipped += 1
            return
        tags = dict(obj.tags)
        row = {k.replace(':', '_'): tags.get(k) for k in FIELDS}
        row.update(osm_type=kind, osm_id=identifier, lat=point.y, lng=point.x, address=''.join(tags.get(k,'') for k in ADDRESS))
        # Storage errors deliberately propagate and abort this unpublished release.
        self.snapshot.add(row)
    def node(self, n):
        if self.relevant(n) and n.location.valid():
            self.save(n, 'node', n.id, self.factory.create_point)
    def way(self, w):
        if self.relevant(w) and not w.is_closed() and len(w.nodes) >= 2:
            self.save(w, 'way', w.id, self.factory.create_linestring)
    def area(self, a):
        if self.relevant(a):
            self.save(a, 'way' if a.from_way() else 'relation', a.orig_id(), self.factory.create_multipolygon)

if __name__ == '__main__':
    snapshot = Snapshot(sys.argv[2])
    extractor = Extractor(snapshot)
    extractor.apply_file(sys.argv[1], locations=True, idx='sparse_file_array')
    print(json.dumps({'places': snapshot.finish(), 'skippedGeometries': extractor.skipped}), flush=True)
