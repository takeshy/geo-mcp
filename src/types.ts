export interface Coordinate {
  lat: number;
  lng: number;
}

export interface LandPricePoint extends Coordinate {
  id: string;
  area: string;
  station: string;
  municipality: string;
  pricePerSqm: number;
  previousPricePerSqm: number;
  stationWalkMinutes: number;
  source: string;
  sourceUrl: string;
  observedAt: string;
  commuteProfiles?: CommuteProfile[];
}

export interface CommuteProfile extends Coordinate {
  destination: string;
  durationMinutes: number;
  transfers: number | null;
  source: string;
  observedAt: string;
}

export interface CommuteResult {
  durationMinutes: number;
  transfers: number | null;
  fareYen: number | null;
  mode: "precomputed-transit" | "estimate";
  warning?: string;
}

export interface Candidate extends LandPricePoint {
  commute: CommuteResult;
  trendPercent: number;
  score: number;
}

export interface CandidateSearchInput {
  destination: Coordinate & { name?: string };
  maxCommuteMinutes: number;
  maxPricePerSqm?: number;
  maxStationWalkMinutes?: number;
  limit?: number;
  arrivalTime?: string;
}
