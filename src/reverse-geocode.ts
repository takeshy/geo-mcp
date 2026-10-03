import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { metres, PlaceError, type PlaceAnswer } from "./places.js";
import type { GeoPoint } from "./coverage.js";

const earthRadius = 6371000;
const attribution = { label: "GeoNames (CC BY 4.0)", url: "https://www.geonames.org/" };

/** Disk-backed worldwide index. Unit-sphere coordinates handle poles/date line. */
export class SettlementIndex {
  private db?: DatabaseSync;
  constructor(private path: string) {}
  close() { this.db?.close(); this.db = undefined; }

  nearest(point: GeoPoint) {
    const db = this.db ??= new DatabaseSync(this.path, { readOnly: true });
    const phi = point.lat * Math.PI / 180, theta = point.lng * Math.PI / 180;
    const x = Math.cos(phi) * Math.cos(theta), y = Math.cos(phi) * Math.sin(theta), z = Math.sin(phi);
    const query = db.prepare(`SELECT p.* FROM settlement_spatial s JOIN settlements p ON p.id = s.id
      WHERE s.min_x <= ? AND s.max_x >= ? AND s.min_y <= ? AND s.max_y >= ? AND s.min_z <= ? AND s.max_z >= ?`);
    // Limit to 100 km: open ocean should not be described as belonging to a town.
    for (const radius of [1000, 5000, 20000, 50000, 100000]) {
      const chord = 2 * Math.sin(radius / (2 * earthRadius));
      const rows = query.all(x + chord, x - chord, y + chord, y - chord, z + chord, z - chord);
      const matches = rows.map(row => ({
        geonameId: Number(row.id), name: String(row.name), countryCode: String(row.country_code),
        admin1Code: String(row.admin1_code), lat: Number(row.lat), lng: Number(row.lng),
        distanceMetres: metres(point, { lat: Number(row.lat), lng: Number(row.lng) }),
      })).filter(row => row.distanceMetres <= radius)
        .sort((a, b) => a.distanceMetres - b.distanceMetres || a.geonameId - b.geonameId);
      // Any point outside this cube is farther than the search radius.
      if (matches[0]) return matches[0];
    }
  }
}

let runtimeIndex: SettlementIndex | undefined;
export function reverseGeocode(point: GeoPoint, index?: SettlementIndex): PlaceAnswer {
  if (![point.lat, point.lng].every(Number.isFinite) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
    throw new PlaceError("緯度・経度を正しい範囲で両方指定してください");
  }
  index ??= runtimeIndex ??= new SettlementIndex(process.env.LOCAL_SETTLEMENTS_SQLITE?.trim()
    || fileURLToPath(new URL("../data/geonames/settlements.sqlite", import.meta.url)));
  let nearest;
  try { nearest = index.nearest(point); }
  catch { throw new PlaceError("地名データを読み込めませんでした。GeoNamesのローカル索引を作成・配置してください。"); }
  const data = { center: point, source: "local", provider: "geonames", approximate: true,
    method: "nearest_settlement", maxDistanceKm: 100 };
  if (!nearest) return {
    text: "100km以内に登録された町・村が見つかりませんでした。", data: { ...data, found: false }, links: [attribution],
  };
  const place = { ...nearest, distanceMetres: Math.round(nearest.distanceMetres) };
  return {
    text: `${place.name}${place.countryCode ? `（${place.countryCode}）` : ""}付近です。登録地点から約${(place.distanceMetres / 1000).toFixed(1)}km。最寄りの町・村による目安で、行政区域の判定ではありません。`,
    data: { ...data, found: true, place },
    links: [attribution, { label: place.name, url: `https://www.geonames.org/${place.geonameId}/` }],
  };
}
