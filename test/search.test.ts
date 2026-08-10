import assert from "node:assert/strict";
import test from "node:test";
import { computeCommute, estimateTransit, haversineKm } from "../src/commute.js";
import { LandPriceRepository } from "../src/data.js";
import { findCandidates } from "../src/search.js";

test("haversine distance is zero for one point", () => {
  assert.equal(haversineKm({ lat: 35, lng: 139 }, { lat: 35, lng: 139 }), 0);
});

test("demo commute estimate is deterministic", () => {
  const value = estimateTransit({ lat: 35.6812, lng: 139.7671 }, { lat: 35.6812, lng: 139.7671 });
  assert.equal(value.durationMinutes, 8);
  assert.equal(value.mode, "estimate");
});

test("precomputed transit profile is preferred for a matching destination", async () => {
  const value = await computeCommute(
    { lat: 35.691, lng: 140.0203 },
    { lat: 35.6812, lng: 139.7671 },
    undefined,
    [{ destination: "東京駅", lat: 35.6812, lng: 139.7671, durationMinutes: 29, transfers: 0, source: "test", observedAt: "2026-01-01" }],
  );
  assert.equal(value.durationMinutes, 29);
  assert.equal(value.mode, "precomputed-transit");
});

test("Tokyo Station search returns candidates within 45 minutes", async () => {
  const points = await new LandPriceRepository().all();
  const candidates = await findCandidates(points, {
    destination: { name: "東京駅", lat: 35.6812, lng: 139.7671 },
    maxCommuteMinutes: 45,
    maxStationWalkMinutes: 20,
    limit: 10,
  });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => candidate.commute.durationMinutes <= 45));
  assert.ok(candidates.every((candidate) => candidate.commute.mode === "precomputed-transit"));
});

test("candidate search filters price and sorts score", async () => {
  const points = await new LandPriceRepository().all();
  const candidates = await findCandidates(points, {
    destination: { lat: 35.6812, lng: 139.7671 },
    maxCommuteMinutes: 120,
    maxPricePerSqm: 300_000,
    maxStationWalkMinutes: 20,
    limit: 3,
  });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((candidate) => candidate.pricePerSqm <= 300_000));
  assert.ok(candidates[0]!.score >= candidates[1]!.score);
});
