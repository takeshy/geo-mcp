import { hybridPlaceSearch, hybridRoute, runtimeHybrid, type HybridDeps } from "./hybrid.js";
// Nearby places and road routes from OpenStreetMap services.
//
// These answer "what is around here" and "how long to get there" for a
// position the caller passes in. The endpoints are the operator's; the defaults
// are the public services, which need no key, ask for a User-Agent and allow
// about one request per second.

export interface PlaceEndpoints {
  nominatim: string;
  overpass: string;
  osrmCar: string;
  osrmFoot: string;
  osrmBike: string;
  userAgent: string;
}

export function endpointsFromEnv(env: NodeJS.ProcessEnv = process.env): PlaceEndpoints {
  const pick = (name: string, fallback: string) => env[`EXTERNAL_${name}`]?.trim() || env[name]?.trim() || fallback;
  return {
    nominatim: pick("NOMINATIM_URL", "https://nominatim.openstreetmap.org"),
    overpass: pick("OVERPASS_URL", "https://overpass-api.de/api/interpreter"),
    osrmCar: pick("OSRM_CAR_URL", "https://router.project-osrm.org"),
    osrmFoot: pick("OSRM_FOOT_URL", "https://routing.openstreetmap.de/routed-foot"),
    osrmBike: pick("OSRM_BIKE_URL", "https://routing.openstreetmap.de/routed-bike"),
    userAgent: pick("OSM_USER_AGENT", "geo-home-mcp (https://github.com/takeshy/geo-home-mcp)"),
  };
}

export interface PlaceDeps {
  hybrid?: HybridDeps;
  endpoints: PlaceEndpoints;
  fetch: typeof fetch;
  // Waits between retries; tests replace it so they do not sleep.
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(): PlaceDeps {
  return { hybrid: runtimeHybrid(), endpoints: endpointsFromEnv(), fetch: throttledFetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
}

export interface Link {
  label: string;
  url: string;
}

// A tool answer: text for the model, the data behind it, and where it came from.
export interface PlaceAnswer {
  text: string;
  data: Record<string, unknown>;
  links: Link[];
}

// PlaceError is a failure the caller should see as one. An unreachable or
// overloaded map service must never read as "nothing found".
export class PlaceError extends Error {}

export interface PlaceSearchInput {
  query: string;
  lat?: number;
  lng?: number;
  radius?: number;
}

export async function externalPlaceSearch(input: PlaceSearchInput, deps: PlaceDeps = defaultDeps()): Promise<PlaceAnswer> {
  const query = input.query.trim();
  if (!query) throw new PlaceError("検索語がありません");
  if (input.lat === undefined || input.lng === undefined) {
    // Without a position this is a plain lookup, and saying so is a better
    // answer than pretending to know where the user is.
    const found = await geocode(query, deps);
    if (found.length === 0) return { text: "見つかりませんでした。", data: { query, mode: "name", places: [] }, links: [] };
    return {
      text: "位置が分からないので、名前で引いた結果です。\n" + found.map((place) => `- ${place.name}`).join("\n"),
      data: { query, mode: "name", places: found },
      links: [{ label: "Nominatim (OpenStreetMap)", url: "https://nominatim.openstreetmap.org/" }],
    };
  }
  const radius = input.radius && input.radius > 0 && input.radius <= 5000 ? input.radius : 1200;
  return around(query, { lat: input.lat, lng: input.lng }, radius, deps);
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Japanese category words are not OSM tag values (for example ramen).
export const categories: Record<string, [tag: string, value: string][]> = {
  "ラーメン": [["cuisine", "ramen"]],
  "カフェ": [["amenity", "cafe"]],
  "喫茶店": [["amenity", "cafe"]],
  "レストラン": [["amenity", "restaurant"]],
  "スーパー": [["shop", "supermarket"]],
  "薬局": [["amenity", "pharmacy"], ["shop", "chemist"]],
  "コンビニ": [["shop", "convenience"]],
};

async function around(query: string, at: { lat: number; lng: number }, radius: number, deps: PlaceDeps): Promise<PlaceAnswer> {
  const within = `around:${Math.round(radius)},${at.lat},${at.lng}`;
  // Name, cuisine and amenity all get the same words: a query is whatever the
  // model thought to ask for, not a tag the user has to know.
  const pattern = overpassString(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const clauses = ["name", "cuisine", "amenity"].map((tag) => `  nwr(${within})["${tag}"~${pattern},i];`);
  for (const category of categories[query] ?? []) clauses.push(`  nwr(${within})["${category[0]}"~"(^|;)${category[1]}(;|$)",i];`);
  const ql = `[out:json][timeout:20];\n(\n${clauses.join("\n")}\n);\nout center 30;`;

  const response = await overpassRequest(ql, deps);
  let payload: { elements?: OverpassElement[]; remark?: string };
  try {
    payload = await response.json() as typeof payload;
  } catch (error) {
    throw new PlaceError(`周辺検索の結果を取得できませんでした（店舗がないという意味ではありません）: ${String(error)}`);
  }
  if (payload.remark || !Array.isArray(payload.elements)) {
    throw new PlaceError("周辺検索が完了しませんでした。時間をおいて再試行してください（店舗がないという意味ではありません）");
  }

  const seen = new Set<string>();
  const places = payload.elements.flatMap((element) => {
    const tags = element.tags ?? {};
    const name = tags.name;
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const lat = element.center?.lat ?? element.lat;
    const lng = element.center?.lon ?? element.lon;
    if (lat === undefined || lng === undefined) return [];
    return [{
      name,
      lat,
      lng,
      distanceMetres: Math.round(metres(at, { lat, lng })),
      kind: ["amenity", "shop", "cuisine"].map((key) => tags[key]).filter(Boolean).join(" / ") || undefined,
      openingHours: tags.opening_hours || undefined,
      address: ["addr:city", "addr:suburb", "addr:neighbourhood", "addr:block_number", "addr:housenumber"].map((key) => tags[key]).filter(Boolean).join("") || undefined,
      osm: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    }];
  }).sort((a, b) => a.distanceMetres - b.distanceMetres).slice(0, 12);

  const data = { query, mode: "nearby", center: at, radiusMetres: radius, places };
  if (places.length === 0) {
    return { text: `${Math.round(radius)}m以内に「${query}」らしきものは見つかりませんでした。`, data, links: [] };
  }
  const lines = places.map((place) => [
    `- ${place.name}（約${place.distanceMetres}m）`,
    place.kind && `  ${place.kind}`,
    place.openingHours && `  営業時間: ${place.openingHours}`,
    place.address && `  ${place.address}`,
  ].filter(Boolean).join("\n"));
  return {
    text: lines.join("\n") + "\n営業時間は地図に登録がある場合だけで、いま営業中かは保証しません。",
    data,
    links: [{ label: "OpenStreetMap", url: `https://www.openstreetmap.org/#map=17/${at.lat}/${at.lng}` }],
  };
}

// Overpass QL strings take the same escapes as JSON for quotes and backslashes.
function overpassString(value: string): string {
  return JSON.stringify(value);
}

// Retry temporary overload once. Never disguise an unavailable service as no hits.
async function overpassRequest(ql: string, deps: PlaceDeps): Promise<Response> {
  const endpoint = deps.endpoints.overpass;
  if (!endpoint) throw new PlaceError("周辺検索の接続先が設定されていません");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await deps.sleep(1000);
    let response: Response;
    try {
      response = await deps.fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": deps.endpoints.userAgent },
        body: "data=" + encodeURIComponent(ql),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      if (attempt === 0) continue;
      throw new PlaceError(`周辺検索に接続できませんでした（店舗がないという意味ではありません）: ${String(error)}`);
    }
    if (response.ok) return response;
    if (attempt === 0 && !response.headers.get("Retry-After") && [429, 502, 503, 504].includes(response.status)) continue;
    throw new PlaceError(`周辺検索を取得できませんでした (${response.status})。時間をおいて再試行してください。店舗がないという意味ではありません`);
  }
  throw new PlaceError("周辺検索を取得できませんでした");
}

export interface Geocoded {
  name: string;
  lat: number;
  lng: number;
}

export async function geocode(query: string, deps: PlaceDeps): Promise<Geocoded[]> {
  const base = deps.endpoints.nominatim.replace(/\/+$/, "");
  if (!base) throw new PlaceError("地名検索の接続先が設定されていません");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=ja`;
  const response = await get(url, deps, "地名検索");
  const rows = await response.json() as Array<{ display_name?: string; lat?: string; lon?: string }>;
  if (!Array.isArray(rows)) throw new PlaceError("地名検索の結果を読めませんでした");
  return rows.flatMap((row) => {
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    return row.display_name && Number.isFinite(lat) && Number.isFinite(lng) ? [{ name: row.display_name, lat, lng }] : [];
  });
}

export type RouteMode = "driving" | "walking" | "cycling";

export interface RouteInput {
  to?: string;
  toLat?: number;
  toLng?: number;
  lat: number;
  lng: number;
  mode?: RouteMode;
}

export async function externalRoute(input: RouteInput, deps: PlaceDeps = defaultDeps()): Promise<PlaceAnswer> {
  const destination = input.to?.trim() || (input.toLat !== undefined ? `${input.toLat},${input.toLng}` : "");
  if (!destination) throw new PlaceError("目的地がありません");
  const mode = input.mode ?? "driving";
  const base = { driving: deps.endpoints.osrmCar, walking: deps.endpoints.osrmFoot, cycling: deps.endpoints.osrmBike }[mode]?.replace(/\/+$/, "");
  if (!base) throw new PlaceError("指定した移動手段の経路検索の接続先が設定されていません");
  // OSRM profiles belong to the prepared data, not the URL profile token.
  // Refuse the known car-only public endpoint for non-car modes.
  if (mode !== "driving" && new URL(base).hostname.toLowerCase() === "router.project-osrm.org") {
    throw new PlaceError("この接続先は車用です。徒歩・自転車に対応した接続先を設定してください");
  }

  const found = input.toLat !== undefined && input.toLng !== undefined ? { name: destination, lat: input.toLat, lng: input.toLng } : (await geocode(destination, deps))[0];
  if (!found) return { text: "目的地が見つかりませんでした。", data: { to: destination, mode, found: false }, links: [] };

  const response = await get(`${base}/route/v1/driving/${input.lng},${input.lat};${found.lng},${found.lat}?overview=false`, deps, "経路検索");
  const payload = await response.json() as { code?: string; routes?: Array<{ distance: number; duration: number }> };
  const best = payload.code === "Ok" ? payload.routes?.[0] : undefined;
  if (payload.code !== "Ok" && payload.code !== "NoRoute") throw new PlaceError("経路検索の結果を読めませんでした");
  if (best && (![best.distance, best.duration].every(Number.isFinite) || best.distance < 0 || best.duration < 0)) throw new PlaceError("経路検索の距離・時間が不正です");
  if (!best) return { text: "経路が見つかりませんでした。", data: { to: destination, mode, destination: found, found: false }, links: [] };

  const minutes = Math.ceil(best.duration / 60);
  const km = Math.round(best.distance / 100) / 10;
  const label = { driving: "車", walking: "徒歩", cycling: "自転車" }[mode];
  const engine = { driving: "car", walking: "foot", cycling: "bike" }[mode];
  // The routing service knows roads, not timetables. Saying which question was
  // answered is the difference between a useful number and a wrong one.
  return {
    text: `${found.name} まで ${label} で約${minutes}分（${km.toFixed(1)}km）。公共交通・リアルタイムの渋滞は含みません。`,
    data: { to: destination, mode, origin: { lat: input.lat, lng: input.lng }, destination: found, durationMinutes: minutes, distanceKm: km },
    links: [{
      label: "OSRM",
      url: `https://www.openstreetmap.org/directions?engine=fossgis_osrm_${engine}&from=${input.lat},${input.lng}&to=${found.lat},${found.lng}`,
    }],
  };
}

async function get(url: string, deps: PlaceDeps, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { "User-Agent": deps.endpoints.userAgent }, signal: AbortSignal.timeout(25_000) });
  } catch (error) {
    throw new PlaceError(`${what}に接続できませんでした: ${String(error)}`);
  }
  if (!response.ok) throw new PlaceError(`${what}が失敗しました (${response.status})`);
  return response;
}

// metres is the great-circle distance, which is close enough at city scale.
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// The public geocoding and routing services allow one request per second.
// Share the slot across every session in this process.
const publicHosts = new Set(["nominatim.openstreetmap.org", "router.project-osrm.org", "routing.openstreetmap.de"]);
const nextSlot = new Map<string, number>();

const throttledFetch: typeof fetch = async (input, init) => {
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname.toLowerCase();
  if (publicHosts.has(host)) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + 1000);
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
  return fetch(input, init);
};

export const placeSearch = (input: PlaceSearchInput, deps: PlaceDeps = defaultDeps()) => hybridPlaceSearch(input, deps);
export const route = (input: RouteInput, deps: PlaceDeps = defaultDeps()) => hybridRoute(input, deps);
