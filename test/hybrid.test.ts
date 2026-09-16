import assert from "node:assert/strict";
import test from "node:test";
import { BoundingBoxCoverage } from "../src/coverage.js";
import { OsrmRouteProvider, type HybridDeps, type Place } from "../src/hybrid.js";
import { LocalPlaceProvider } from "../src/local-places.js";
import { endpointsFromEnv, placeSearch, route, type PlaceDeps } from "../src/places.js";
const tokyo = { lat: 35.68, lng: 139.76 };
const osaka = { lat: 34.69, lng: 135.50 };
const coverage = new BoundingBoxCoverage([{ name: "test", west: 139, east: 140, south: 35, north: 36 }]);
const cafe: Place = { ...tokyo, name: "喫茶店", openingHours: "Mo-Fr 09:00-18:00", distanceMetres: 10 };
function fixture(options: Partial<HybridDeps> = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const hybrid: HybridDeps = { coverage, places: { search: async () => [cafe] }, routes: Object.fromEntries(["driving", "walking", "cycling"].map(m => [m, new OsrmRouteProvider(`http://${m}.local:5000`)])), fallbackEnabled: true, fallbackOnEmpty: false, fallbackOnError: false, log: r => logs.push(r), ...options };
  const deps: PlaceDeps = { hybrid, endpoints: endpointsFromEnv({}), sleep: async () => {}, fetch: (async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).includes("/route/") ? { code: "Ok", routes: [{ distance: 100, duration: 60 }] } : String(url).includes("/search?") ? [{ display_name: "大阪", lat: String(osaka.lat), lon: String(osaka.lng) }] : { elements: [] }), { status: 200 });
  }) as typeof fetch };
  return { deps, calls, logs, hybrid };
}
test("coverage includes boundaries and rejects invalid configuration", () => {
  assert.equal(coverage.contains({ lat: 35, lng: 139 }), true);
  assert.equal(coverage.contains(osaka), false);
  assert.throws(() => new BoundingBoxCoverage([{ name: "bad", west: 140, east: 139, south: 35, north: 36 }]));
});
test("local POIs keep hours, provenance and observability without network", async () => {
  const f = fixture();
  const answer = await placeSearch({ query: "カフェ", ...tokyo }, f.deps);
  assert.equal(answer.data.source, "local");
  assert.equal(answer.data.provider, "openstreetmap");
  assert.match(answer.text, /Mo-Fr/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.logs[0]?.resultCount, 1);
  assert.equal(f.logs[0]?.tool, "place_search");
});
test("outside coverage uses Overpass; missing provider reports disabled", async () => {
  for (const [options, position, reason] of [[{}, osaka, "outside_coverage"], [{ places: undefined }, tokyo, "local_disabled"]] as const) {
    const f = fixture(options);
    const answer = await placeSearch({ query: "薬局", ...position }, f.deps);
    assert.equal(answer.data.fallbackReason, reason);
    assert.equal(answer.data.provider, "overpass");
    assert.equal(f.calls.length, 1);
  }
});
test("nearby empty results stay local unless verification fallback is enabled", async () => {
  for (const enabled of [false, true]) {
    const f = fixture({ places: { search: async () => [] }, fallbackOnEmpty: enabled });
    const answer = await placeSearch({ query: "カフェ", ...tokyo }, f.deps);
    assert.equal(answer.data.source, enabled ? "external" : "local");
    assert.equal(f.calls.length, enabled ? 1 : 0);
    if (enabled) assert.equal(answer.data.fallbackReason, "local_empty");
  }
});
test("name misses go to Nominatim independently of nearby empty policy", async () => {
  const f = fixture({ places: { search: async () => [] } });
  const answer = await placeSearch({ query: "大阪" }, f.deps);
  assert.equal(answer.data.provider, "nominatim");
  assert.equal(answer.data.fallbackReason, "local_empty");
});
test("errors are propagated by default and fall back only when explicitly enabled", async () => {
  for (const enabled of [false, true]) {
    const f = fixture({ places: { search: async () => { throw new Error("database unavailable"); } }, fallbackOnError: enabled });
    if (enabled) assert.equal((await placeSearch({ query: "カフェ", ...tokyo }, f.deps)).data.fallbackReason, "local_error");
    else await assert.rejects(placeSearch({ query: "カフェ", ...tokyo }, f.deps), /database unavailable/);
    assert.equal(f.calls.length, enabled ? 1 : 0);
  }
});
test("master switch blocks all external paths, including destination geocoding", async () => {
  const f = fixture({ fallbackEnabled: false, fallbackOnEmpty: true, fallbackOnError: true, places: { search: async () => [] } });
  assert.equal((await placeSearch({ query: "カフェ", ...tokyo }, f.deps)).data.source, "local");
  await assert.rejects(placeSearch({ query: "大阪" }, f.deps), /自前検索対象外/);
  await assert.rejects(placeSearch({ query: "カフェ", ...osaka }, f.deps), /自前検索対象外/);
  await assert.rejects(route({ to: "大阪", ...tokyo }, f.deps), /自前検索対象外/);
  await assert.rejects(route({ ...tokyo, toLat: osaka.lat, toLng: osaka.lng }, f.deps), /自前検索対象外/);
  assert.deepEqual(f.calls, []);
});
for (const mode of ["driving", "walking", "cycling"] as const) {
  test(`${mode} uses local graph for two covered endpoints and public graph for cross-region route`, async () => {
    const f = fixture();
    const local = await route({ ...tokyo, toLat: 35.5, toLng: 139.5, mode }, f.deps);
    assert.equal(local.data.source, "local");
    assert.match(f.calls[0]!, new RegExp(`http://${mode}.local`));
    assert.equal(f.calls.length, 1);
    const external = await route({ ...tokyo, toLat: osaka.lat, toLng: osaka.lng, mode }, f.deps);
    assert.equal(external.data.fallbackReason, "outside_coverage");
    assert.equal(external.data.provider, "osrm");
  });
}
test("route destination uses local name search and records separate provenance", async () => {
  const f = fixture();
  const answer = await route({ ...tokyo, to: "喫茶店" }, f.deps);
  assert.equal((answer.data.geocoding as Record<string, unknown>).source, "local");
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!, /\/route\//);
});
test("local OSRM failure falls back according to error policy", async () => {
  const f = fixture({ fallbackOnError: true, routes: { walking: { route: async () => { throw new Error("unavailable"); } } } });
  const result = await route({ ...tokyo, toLat: tokyo.lat, toLng: tokyo.lng, mode: "walking" }, f.deps);
  assert.equal(result.data.fallbackReason, "local_error");
  assert.match(f.calls[0]!, /routed-foot/);
});
test("incomplete and invalid coordinates fail before any provider call", async () => {
  const f = fixture();
  await assert.rejects(placeSearch({ query: "x", lat: 35 }, f.deps));
  await assert.rejects(route({ ...tokyo, toLat: 35, to: "x" }, f.deps));
  await assert.rejects(route({ ...tokyo, toLat: NaN, toLng: 139 }, f.deps));
  await assert.rejects(route({ ...tokyo }, f.deps));
  assert.deepEqual(f.calls, []);
});
test("SQL parameters isolate search strings and pharmacy includes both category tags", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const provider = new LocalPlaceProvider({ query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } });
  await provider.search({ query: "薬局", ...tokyo });
  assert.match(calls[0]!.sql, /ST_DWithin/);
  assert.ok(calls[0]!.values.includes("pharmacy"));
  assert.ok(calls[0]!.values.includes("chemist"));
  await provider.search({ query: "%' OR true --" });
  assert.ok(!calls[1]!.sql.includes("OR true --"));
  assert.equal(calls[1]!.values[0], "%\\%' OR true --%");
});
test("new endpoint names take precedence and legacy settings remain supported", () => {
  assert.equal(endpointsFromEnv({ EXTERNAL_OSRM_CAR_URL: "https://new.example", OSRM_CAR_URL: "https://old.example" }).osrmCar, "https://new.example");
  assert.equal(endpointsFromEnv({ NOMINATIM_URL: "https://legacy.example" }).nominatim, "https://legacy.example");
});
test("local NoRoute remains a local result even with error fallback enabled", async () => {
  const f = fixture({ fallbackOnError: true });
  f.deps.fetch = (async () => new Response(JSON.stringify({ code: "NoRoute" }))) as typeof fetch;
  const answer = await route({ ...tokyo, toLat: tokyo.lat, toLng: tokyo.lng }, f.deps);
  assert.equal(answer.data.source, "local");
  assert.equal(answer.data.found, false);
});
test("master switch also prevents fallback on database and router failures", async () => {
  const f = fixture({ fallbackEnabled: false, fallbackOnError: true, places: { search: async () => { throw new Error("db offline"); } }, routes: { driving: { route: async () => { throw new Error("router offline"); } } } });
  await assert.rejects(placeSearch({ query: "カフェ", ...tokyo }, f.deps), /db offline/);
  await assert.rejects(route({ ...tokyo, toLat: tokyo.lat, toLng: tokyo.lng }, f.deps), /router offline/);
  assert.deepEqual(f.calls, []);
});
test("an uncovered origin also selects the external router", async () => {
  const f = fixture();
  const answer = await route({ ...osaka, toLat: tokyo.lat, toLng: tokyo.lng }, f.deps);
  assert.equal(answer.data.fallbackReason, "outside_coverage");
});
