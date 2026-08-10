import { computeCommute } from "./commute.js";
import type { Candidate, CandidateSearchInput, LandPricePoint } from "./types.js";

export async function findCandidates(
  points: LandPricePoint[],
  input: CandidateSearchInput,
): Promise<Candidate[]> {
  const maxWalk = input.maxStationWalkMinutes ?? 20;
  const eligible = points.filter((point) =>
    point.stationWalkMinutes <= maxWalk &&
    (input.maxPricePerSqm === undefined || point.pricePerSqm <= input.maxPricePerSqm),
  );
  const candidates = await Promise.all(eligible.map(async (point): Promise<Candidate> => {
    const commute = await computeCommute(point, input.destination, input.arrivalTime);
    const trendPercent = ((point.pricePerSqm - point.previousPricePerSqm) / point.previousPricePerSqm) * 100;
    const priceScore = input.maxPricePerSqm
      ? Math.max(0, 1 - point.pricePerSqm / input.maxPricePerSqm)
      : 1 / Math.max(1, point.pricePerSqm / 100_000);
    const commuteScore = Math.max(0, 1 - commute.durationMinutes / input.maxCommuteMinutes);
    const walkScore = Math.max(0, 1 - point.stationWalkMinutes / Math.max(1, maxWalk));
    return { ...point, commute, trendPercent, score: round(100 * (0.45 * commuteScore + 0.4 * priceScore + 0.15 * walkScore)) };
  }));
  return candidates
    .filter((candidate) => candidate.commute.durationMinutes <= input.maxCommuteMinutes)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 10);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
