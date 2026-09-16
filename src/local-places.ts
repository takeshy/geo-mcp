import pg from "pg";
import { categories, type PlaceSearchInput } from "./places.js";
import type { Place, PlaceProvider } from "./hybrid.js";
export interface SqlClient { query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export class LocalPlaceProvider implements PlaceProvider {
  private db: SqlClient;
  constructor(connection: string | SqlClient) {
    this.db = typeof connection === "string" ? new pg.Pool({ connectionString: connection, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000, idleTimeoutMillis: 30000 }) : connection;
  }
  async search(input: PlaceSearchInput): Promise<Place[]> {
    const nearby = input.lat !== undefined && input.lng !== undefined;
    const pattern = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
    const values: unknown[] = [pattern, input.query];
    let condition = "(name ILIKE $1 OR name_ja ILIKE $1 OR brand ILIKE $1)";
    if (nearby) {
      const filters = (categories[input.query] ?? []).map(([tag, value]) => {
        values.push(value);
        return `$${values.length} = ANY(string_to_array(lower(${tag}), ';'))`;
      });
      if (filters.length) condition = `(${condition} OR ${filters.join(" OR ")})`;
    }
    let distance = "NULL";
    if (nearby) {
      values.push(input.lng, input.lat, input.radius ?? 1200);
      const point = `ST_SetSRID(ST_MakePoint($${values.length - 2}, $${values.length - 1}),4326)::geography`;
      condition += ` AND ST_DWithin(geom, ${point}, $${values.length})`;
      distance = `round(ST_Distance(geom, ${point}))`;
    }
    const { rows } = await this.db.query(`SELECT *, ${distance} AS distance_metres FROM places WHERE ${condition} ORDER BY ${nearby ? "distance_metres," : ""} COALESCE(name = $2 OR name_ja = $2, false) DESC, osm_type, osm_id LIMIT ${nearby ? 12 : 5}`, values);
    return rows.map(r => ({
      name: String(r.name_ja || r.name || r.brand || "名称未登録"), lat: Number(r.lat), lng: Number(r.lng),
      ...(nearby ? { distanceMetres: Number(r.distance_metres) } : {}),
      kind: ["amenity", "shop", "tourism", "leisure", "office", "healthcare", "cuisine"].map(k => r[k]).filter(Boolean).join(" / ") || undefined,
      openingHours: r.opening_hours ? String(r.opening_hours) : undefined,
      address: r.address ? String(r.address) : undefined,
      osm: `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}`,
    }));
  }
}
