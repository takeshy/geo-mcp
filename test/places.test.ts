import assert from "node:assert/strict";
import test from "node:test";
import { endpointsFromEnv, placeSearch, PlaceError, route, type PlaceDeps } from "../src/places.js";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function deps(handler: Handler, env: NodeJS.ProcessEnv = {}): PlaceDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    endpoints: endpointsFromEnv(env),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      return handler(url, init);
    }) as typeof fetch,
    sleep: async () => {},
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("place_search near a position lists named places by distance without duplicates", async () => {
  let body = "";
  const fake = deps((_url, init) => {
    body = decodeURIComponent(String(init?.body));
    return json({
      elements: [
        { type: "node", id: 2, lat: 35.662, lon: 139.705, tags: { name: "遠い店", cuisine: "ramen" } },
        { type: "way", id: 1, center: { lat: 35.6581, lon: 139.7017 }, tags: { name: "近い店", amenity: "restaurant", cuisine: "ramen", opening_hours: "11:00-22:00" } },
        { type: "node", id: 3, lat: 35.662, lon: 139.705, tags: { name: "近い店" } },
        { type: "node", id: 4, lat: 35.662, lon: 139.705, tags: {} },
      ],
    });
  });
  const answer = await placeSearch({ query: "ラーメン", lat: 35.658, lng: 139.7016, radius: 800 }, fake);

  assert.match(body, /around:800,35\.658,139\.7016/);
  assert.match(body, /"cuisine"~"\(\^\|;\)ramen\(;\|\$\)"/);
  const places = answer.data.places as Array<{ name: string; openingHours?: string }>;
  assert.deepEqual(places.map((place) => place.name), ["近い店", "遠い店"]);
  assert.equal(places[0]!.openingHours, "11:00-22:00");
  assert.match(answer.text, /営業時間: 11:00-22:00/);
  assert.equal(answer.links[0]!.label, "OpenStreetMap");
});

test("place_search without a position falls back to a name lookup and says so", async () => {
  const fake = deps(() => json([{ display_name: "渋谷駅, 東京都", lat: "35.658", lon: "139.7016" }]));
  const answer = await placeSearch({ query: "渋谷駅" }, fake);
  assert.match(fake.calls[0]!, /^https:\/\/nominatim\.openstreetmap\.org\/search\?q=/);
  assert.match(answer.text, /位置が分からないので/);
  assert.equal(answer.data.mode, "name");
});

test("an overloaded Overpass is retried once and then reported, not shown as no hits", async () => {
  const fake = deps(() => new Response("busy", { status: 504 }));
  await assert.rejects(placeSearch({ query: "カフェ", lat: 35, lng: 139 }, fake), (error) =>
    error instanceof PlaceError && /店舗がないという意味ではありません/.test(error.message));
  assert.equal(fake.calls.length, 2);
});

test("route geocodes the destination and reports road time from the given position", async () => {
  const fake = deps((url) => url.includes("/search?")
    ? json([{ display_name: "東京駅", lat: "35.6812", lon: "139.7671" }])
    : json({ code: "Ok", routes: [{ distance: 6540, duration: 1450 }] }));
  const answer = await route({ to: "東京駅", lat: 35.658, lng: 139.7016, mode: "walking" }, fake);

  assert.equal(fake.calls[1], "https://routing.openstreetmap.de/routed-foot/route/v1/driving/139.7016,35.658;139.7671,35.6812?overview=false");
  assert.equal(answer.text, "東京駅 まで 徒歩 で約25分（6.5km）。公共交通・リアルタイムの渋滞は含みません。");
  assert.equal(answer.data.durationMinutes, 25);
  assert.match(answer.links[0]!.url, /engine=fossgis_osrm_foot/);
});

test("route refuses walking on the car-only public OSRM", async () => {
  const fake = deps(() => json([]), { OSRM_FOOT_URL: "https://router.project-osrm.org" });
  await assert.rejects(route({ to: "東京駅", lat: 35, lng: 139, mode: "walking" }, fake), /車用です/);
  assert.equal(fake.calls.length, 0);
});
