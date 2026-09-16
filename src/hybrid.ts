import { SqlitePlaceProvider } from "./sqlite-places.js";
import { GoogleAuth } from "google-auth-library";
import { coverageFromFile, type Coverage, type GeoPoint } from "./coverage.js";
import { LocalPlaceProvider } from "./local-places.js";
import { externalPlaceSearch, externalRoute, PlaceError, type PlaceAnswer, type PlaceDeps, type PlaceSearchInput, type RouteInput, type RouteMode } from "./places.js";
export interface Place extends GeoPoint { name: string; distanceMetres?: number; kind?: string; openingHours?: string; address?: string; osm?: string }
export interface PlaceProvider { search(input: PlaceSearchInput): Promise<Place[]> }
export interface RouteProvider { route(input: RouteInput, deps: PlaceDeps): Promise<PlaceAnswer> }
export type FallbackReason = "outside_coverage" | "local_error" | "local_empty" | "local_disabled";
export interface HybridDeps {
  coverage: Coverage;
  places?: PlaceProvider;
  routes?: Partial<Record<RouteMode, RouteProvider>>;
  fallbackEnabled: boolean;
  fallbackOnEmpty: boolean;
  fallbackOnError: boolean;
  log?: (record: Record<string, unknown>) => void;
}
export class OsrmRouteProvider implements RouteProvider {
  constructor(private url: string, private authenticated = false) {}
  async route(input: RouteInput, deps: PlaceDeps) {
    const headers = new Headers();
    if (this.authenticated) {
      const client = await new GoogleAuth().getIdTokenClient(new URL(this.url).origin);
      const authHeaders = await client.getRequestHeaders();
      authHeaders.forEach((value, key) => headers.set(key, value));
    }
    const localFetch: typeof fetch = (url, init) => {
      const merged = new Headers(init?.headers);
      headers.forEach((value, key) => merged.set(key, value));
      return deps.fetch(url, { ...init, headers: merged, signal: AbortSignal.timeout(240_000) });
    };
    return externalRoute(input, { ...deps, fetch: localFetch, endpoints: { ...deps.endpoints, osrmCar: this.url, osrmFoot: this.url, osrmBike: this.url } });
  }
}
let runtime: HybridDeps | undefined;
export function runtimeHybrid(): HybridDeps {
  if (runtime) return runtime;
  const env = process.env;
  const flag = (key: string, fallback: boolean) => {
    if (env[key] === undefined || env[key] === "") return fallback;
    if (!["true", "false"].includes(env[key]!)) throw new Error(`${key} must be true or false`);
    return env[key] === "true";
  };
  const routes: HybridDeps["routes"] = {};
  for (const [mode, key] of [["driving", "CAR"], ["walking", "FOOT"], ["cycling", "BIKE"]] as const) {
    const url = env[`LOCAL_OSRM_${key}_URL`]?.trim();
    if (url) routes[mode] = new OsrmRouteProvider(url, flag("LOCAL_OSRM_AUTH", false));
  }
  return runtime = {
    coverage: coverageFromFile(env.LOCAL_COVERAGE_FILE),
    places: env.LOCAL_PLACES_SQLITE ? new SqlitePlaceProvider(env.LOCAL_PLACES_SQLITE) : env.DATABASE_URL ? new LocalPlaceProvider(env.DATABASE_URL) : undefined,
    routes,
    fallbackEnabled: flag("EXTERNAL_FALLBACK_ENABLED", true),
    fallbackOnEmpty: flag("EXTERNAL_FALLBACK_ON_EMPTY", false),
    fallbackOnError: flag("EXTERNAL_FALLBACK_ON_ERROR", false),
    log: record => console.info(JSON.stringify(record)),
  };
}
const disabled: HybridDeps = { coverage: { contains: () => false }, fallbackEnabled: true, fallbackOnEmpty: false, fallbackOnError: false };
function point(lat: number | undefined, lng: number | undefined, required = false) {
  if (lat === undefined && lng === undefined && !required) return;
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new PlaceError("緯度・経度を正しい範囲で両方指定してください");
}
function permit(h: HybridDeps, reason: FallbackReason) {
  if (!h.fallbackEnabled) throw new PlaceError("この地域は現在Geo Homeの自前検索対象外です。");
  if (reason === "local_error" && !h.fallbackOnError) throw new PlaceError("自前地理サービスに接続できませんでした。");
}
function annotate(answer: PlaceAnswer, source: "local" | "external", provider: string, reason?: FallbackReason) {
  return { ...answer, data: { ...answer.data, source, provider, ...(reason ? { fallbackReason: reason } : {}) } };
}
async function observe(tool: string, input: unknown, h: HybridDeps, run: () => Promise<PlaceAnswer>) {
  const start = Date.now();
  try {
    const result = await run();
    const d = result.data;
    h.log?.({ tool, request: input, origin: d.origin ?? d.center, destination: d.destination, source: d.source, provider: d.provider, fallbackReason: d.fallbackReason, durationMs: Date.now() - start, resultCount: Array.isArray(d.places) ? d.places.length : d.found === false ? 0 : 1 });
    return result;
  } catch (error) {
    h.log?.({ tool, request: input, durationMs: Date.now() - start, resultCount: 0, error: error instanceof Error ? error.name : "Error" });
    throw error;
  }
}
export class PlaceResolver {
  constructor(private deps: PlaceDeps) {}
  async search(input: PlaceSearchInput): Promise<PlaceAnswer> {
    const h = this.deps.hybrid ?? disabled;
    point(input.lat, input.lng);
    if (!input.query.trim()) throw new PlaceError("検索語がありません");
    if (input.radius !== undefined && (!Number.isFinite(input.radius) || input.radius <= 0 || input.radius > 5000)) throw new PlaceError("半径は0より大きく5000m以下で指定してください");
    const nearby = input.lat !== undefined;
    let reason: FallbackReason = !h.places ? "local_disabled" : "outside_coverage";
    if (h.places && (!nearby || h.coverage.contains(input as GeoPoint))) {
      let places: Place[] | undefined;
      try { places = await h.places.search({ ...input, query: input.query.trim() }); }
      catch (error) { if (!h.fallbackEnabled || !h.fallbackOnError) throw error; reason = "local_error"; }
      if (places) {
        if (places.length || (nearby && !(h.fallbackEnabled && h.fallbackOnEmpty))) {
          return annotate({
            text: places.length ? (nearby ? "" : "位置が分からないので、名前で引いた結果です。\n") + places.map(p => `- ${p.name}${p.distanceMetres === undefined ? "" : `（約${p.distanceMetres}m）`}${p.kind ? `\n  ${p.kind}` : ""}${p.openingHours ? `\n  営業時間: ${p.openingHours}` : ""}${p.address ? `\n  ${p.address}` : ""}`).join("\n") + "\n営業時間はOSM登録内容で、営業中かは保証しません。" : "OSM登録情報に該当する施設は見つかりませんでした。実際に存在しないことを意味しません。",
            data: { query: input.query.trim(), mode: nearby ? "nearby" : "name", ...(nearby ? { center: { lat: input.lat, lng: input.lng }, radiusMetres: input.radius ?? 1200 } : {}), places },
            links: [{ label: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright" }],
          }, "local", "openstreetmap");
        }
        // A name cannot be classified by coverage until it has been resolved.
        reason = "local_empty";
      }
    }
    permit(h, reason);
    return annotate(await externalPlaceSearch(input, this.deps), "external", nearby ? "overpass" : "nominatim", reason);
  }
}
export class GeocodeResolver {
  constructor(private deps: PlaceDeps) {}
  resolve(query: string) { return new PlaceResolver(this.deps).search({ query }); }
}
export class RouteResolver {
  constructor(private deps: PlaceDeps) {}
  async route(input: RouteInput): Promise<PlaceAnswer> {
    point(input.lat, input.lng, true);
    point(input.toLat, input.toLng);
    const mode = input.mode ?? "driving";
    if (!["driving", "walking", "cycling"].includes(mode)) throw new PlaceError("移動手段が不正です");
    const h = this.deps.hybrid ?? disabled;
    // Preserve the existing early configuration check when local routing is disabled.
    const externalUrl = { driving: this.deps.endpoints.osrmCar, walking: this.deps.endpoints.osrmFoot, cycling: this.deps.endpoints.osrmBike }[mode];
    if (!h.routes?.[mode] && mode !== "driving" && externalUrl && new URL(externalUrl).hostname === "router.project-osrm.org") throw new PlaceError("この接続先は車用です。徒歩・自転車に対応した接続先を設定してください");
    let destination: Place;
    let geocoding: Record<string, unknown> | undefined;
    if (input.toLat !== undefined) destination = { name: input.to?.trim() || `${input.toLat},${input.toLng}`, lat: input.toLat, lng: input.toLng! };
    else {
      if (!input.to?.trim()) throw new PlaceError("目的地がありません");
      const answer = await new GeocodeResolver(this.deps).resolve(input.to);
      geocoding = { source: answer.data.source, provider: answer.data.provider, fallbackReason: answer.data.fallbackReason };
      const found = (answer.data.places as Place[])[0];
      if (!found) return { ...answer, text: "目的地が見つかりませんでした。", data: { ...geocoding, to: input.to, mode, found: false } };
      destination = found;
    }
    const resolved = { ...input, to: destination.name, toLat: destination.lat, toLng: destination.lng, mode };
    const local = h.routes?.[mode];
    let reason: FallbackReason = !local ? "local_disabled" : "outside_coverage";
    if (local && h.coverage.contains(input) && h.coverage.contains(destination)) {
      try {
        const answer = annotate(await local.route(resolved, this.deps), "local", "openstreetmap");
        return { ...answer, data: { ...answer.data, geocoding } };
      } catch (error) { if (!h.fallbackEnabled || !h.fallbackOnError) throw error; reason = "local_error"; }
    }
    permit(h, reason);
    const answer = annotate(await externalRoute(resolved, this.deps), "external", "osrm", reason);
    return { ...answer, data: { ...answer.data, geocoding } };
  }
}
export function hybridPlaceSearch(input: PlaceSearchInput, deps: PlaceDeps) {
  return observe("place_search", input, deps.hybrid ?? disabled, () => new PlaceResolver(deps).search(input));
}
export function hybridRoute(input: RouteInput, deps: PlaceDeps) {
  return observe("route", input, deps.hybrid ?? disabled, () => new RouteResolver(deps).route(input));
}
