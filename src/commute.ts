import type { CommuteResult, Coordinate } from "./types.js";

const cache = new Map<string, { expiresAt: number; value: CommuteResult }>();

export async function computeCommute(
  origin: Coordinate,
  destination: Coordinate,
  arrivalTime?: string,
): Promise<CommuteResult> {
  const key = JSON.stringify([origin, destination, arrivalTime || "now"]);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const value = apiKey
    ? await googleTransit(origin, destination, arrivalTime, apiKey)
    : estimateTransit(origin, destination);
  cache.set(key, { expiresAt: Date.now() + 6 * 60 * 60 * 1000, value });
  return value;
}

async function googleTransit(
  origin: Coordinate,
  destination: Coordinate,
  arrivalTime: string | undefined,
  apiKey: string,
): Promise<CommuteResult> {
  const body: Record<string, unknown> = {
    origin: waypoint(origin),
    destination: waypoint(destination),
    travelMode: "TRANSIT",
    languageCode: "ja",
    units: "METRIC",
  };
  if (arrivalTime) body.arrivalTime = new Date(arrivalTime).toISOString();
  else body.departureTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.travelAdvisory.transitFare,routes.legs.steps.travelMode",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Google Routes API failed (${response.status})`);
  const payload = await response.json() as {
    routes?: Array<{
      duration?: string;
      travelAdvisory?: { transitFare?: { units?: string; nanos?: number } };
      legs?: Array<{ steps?: Array<{ travelMode?: string }> }>;
    }>;
  };
  const route = payload.routes?.[0];
  if (!route?.duration) throw new Error("No public transit route found");
  const transitSteps = route.legs?.flatMap((leg) => leg.steps || []).filter((step) => step.travelMode === "TRANSIT").length || 0;
  const fare = route.travelAdvisory?.transitFare;
  return {
    durationMinutes: Math.ceil(Number.parseFloat(route.duration) / 60),
    transfers: Math.max(0, transitSteps - 1),
    fareYen: fare?.units ? Number(fare.units) + Math.round((fare.nanos || 0) / 1e9) : null,
    mode: "google-transit",
  };
}

function waypoint(point: Coordinate) {
  return { location: { latLng: { latitude: point.lat, longitude: point.lng } } };
}

export function estimateTransit(origin: Coordinate, destination: Coordinate): CommuteResult {
  const distanceKm = haversineKm(origin, destination);
  return {
    durationMinutes: Math.max(8, Math.round(8 + distanceKm * 2.05)),
    transfers: null,
    fareYen: null,
    mode: "estimate",
    warning: "GOOGLE_MAPS_API_KEY is not configured; duration is a straight-line demo estimate.",
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
