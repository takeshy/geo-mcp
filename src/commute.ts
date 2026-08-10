import type { CommuteProfile, CommuteResult, Coordinate } from "./types.js";

const cache = new Map<string, { expiresAt: number; value: CommuteResult }>();

export async function computeCommute(
  origin: Coordinate,
  destination: Coordinate,
  _arrivalTime?: string,
  profiles: CommuteProfile[] = [],
): Promise<CommuteResult> {
  const key = JSON.stringify([origin, destination, profiles]);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const profile = profiles.find((candidate) => haversineKm(candidate, destination) <= 1);
  const value: CommuteResult = profile
    ? {
        durationMinutes: profile.durationMinutes,
        transfers: profile.transfers,
        fareYen: null,
        mode: "precomputed-transit",
        warning: `${profile.source} (${profile.observedAt})`,
      }
    : estimateTransit(origin, destination);
  cache.set(key, { expiresAt: Date.now() + 6 * 60 * 60 * 1000, value });
  return value;
}

export function estimateTransit(origin: Coordinate, destination: Coordinate): CommuteResult {
  const distanceKm = haversineKm(origin, destination);
  return {
    durationMinutes: Math.max(8, Math.round(8 + distanceKm * 2.05)),
    transfers: null,
    fareYen: null,
    mode: "estimate",
    warning: "No precomputed transit profile matched this destination; duration is a straight-line demo estimate.",
  };
}

export function haversineKm(a: Coordinate, b: Coordinate): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
