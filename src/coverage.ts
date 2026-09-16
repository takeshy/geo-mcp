import { readFileSync } from "node:fs";
export interface GeoPoint { lat: number; lng: number }
export interface Coverage { contains(point: GeoPoint): boolean }
export interface CoverageBox { name: string; west: number; south: number; east: number; north: number }
export class BoundingBoxCoverage implements Coverage {
  constructor(readonly boxes: CoverageBox[]) {
    if (!Array.isArray(boxes) || boxes.some(b => !b || ![b.west,b.south,b.east,b.north].every(Number.isFinite) || b.west < -180 || b.east > 180 || b.south < -90 || b.north > 90 || b.west > b.east || b.south > b.north)) throw new Error("Invalid coverage boxes");
  }
  contains(p: GeoPoint): boolean { return this.boxes.some(b => p.lng >= b.west && p.lng <= b.east && p.lat >= b.south && p.lat <= b.north); }
}
export function coverageFromFile(path?: string): Coverage {
  return new BoundingBoxCoverage(path ? JSON.parse(readFileSync(path, "utf8")) : []);
}
