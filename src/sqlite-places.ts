import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { categories, metres, type PlaceSearchInput } from "./places.js";
import type { Place, PlaceProvider } from "./hybrid.js";

/** Immutable snapshot: no writer, journal, connection service, or persistent volume. */
export class SqlitePlaceProvider implements PlaceProvider {
  private db?: DatabaseSync;
  constructor(private path: string) {}
  close() { this.db?.close(); this.db = undefined; }
  async search(input: PlaceSearchInput): Promise<Place[]> {
    const db = this.db ??= new DatabaseSync(this.path, { readOnly: true });
    const q = input.query.toLowerCase();
    const nearby = input.lat !== undefined && input.lng !== undefined;
    const values: SQLInputValue[] = [q];
    let from = 'places p';
    let where = "instr(p.search_name, ?) > 0";
    if (nearby) {
      const filters = (categories[input.query] ?? []).map(([tag, value]) => {
        // Tag names come exclusively from the application's category map.
        values.push(value);
        return `instr(';' || lower(coalesce(p.${tag}, '')) || ';', ';' || ? || ';') > 0`;
      });
      if (filters.length) where = `(${where} OR ${filters.join(' OR ')})`;
      const lat = input.lat!, lng = input.lng!, radius = input.radius ?? 1200;
      // Conservative bounding box; exact spherical distance is applied below.
      const latDelta = radius / 110000;
      const lngDelta = Math.min(180, latDelta / Math.max(0.000001, Math.cos((Math.abs(lat) + latDelta) * Math.PI / 180)));
      from += ' JOIN places_spatial s ON s.id = p.id';
      where += ' AND s.max_lat >= ? AND s.min_lat <= ?';
      values.push(lat - latDelta, lat + latDelta);
      if (lngDelta < 180 && lng - lngDelta >= -180 && lng + lngDelta <= 180) {
        where += ' AND s.max_lng >= ? AND s.min_lng <= ?';
        values.push(lng - lngDelta, lng + lngDelta);
      }
    } else if ([...q].length >= 3) {
      from += ' JOIN places_names n ON n.rowid = p.id';
      where += ' AND places_names MATCH ?';
      values.push('"' + q.replaceAll('"', '""') + '"');
    }
    const rows = db.prepare(`SELECT p.* FROM ${from} WHERE ${where} ${nearby ? '' : 'ORDER BY (lower(coalesce(name_ja, \'\')) = ? OR lower(coalesce(name, \'\')) = ?) DESC, osm_type, osm_id LIMIT 5'}`).all(...values, ...(nearby ? [] : [q, q]));
    return rows.map(r => {
      const point = { lat: Number(r.lat), lng: Number(r.lng) };
      return {
        name: String(r.name_ja || r.name || r.brand || '名称未登録'), ...point,
        ...(nearby ? { distanceMetres: metres(point, { lat: input.lat!, lng: input.lng! }) } : {}),
        kind: ['amenity','shop','tourism','leisure','office','healthcare','cuisine'].map(k => r[k]).filter(Boolean).join(' / ') || undefined,
        openingHours: r.opening_hours ? String(r.opening_hours) : undefined,
        address: r.address ? String(r.address) : undefined,
        osm: `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}`,
      };
    }).filter(p => !nearby || p.distanceMetres! <= (input.radius ?? 1200))
      .sort((a, b) => nearby ? a.distanceMetres! - b.distanceMetres! || a.osm.localeCompare(b.osm) : 0)
      .slice(0, nearby ? 12 : 5)
      .map(p => ({ ...p, ...(nearby ? { distanceMetres: Math.round(p.distanceMetres!) } : {}) }));
  }
}
