import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Storage } from "@google-cloud/storage";
import type { LandPricePoint } from "./types.js";

const dataUrl = new URL("../data/land-prices.demo.json", import.meta.url);

export class LandPriceRepository {
  private cached?: LandPricePoint[];

  async all(): Promise<LandPricePoint[]> {
    if (this.cached) return this.cached;
    const configured = process.env.LAND_PRICE_DATA_PATH?.trim();
    const content = configured?.startsWith("gs://")
      ? await readGcs(configured)
      : await readFile(configured || fileURLToPath(dataUrl), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("Land price data must be an array");
    this.cached = parsed.map(validatePoint);
    return this.cached;
  }

  async byArea(query: string): Promise<LandPricePoint[]> {
    const normalized = query.trim().toLocaleLowerCase("ja");
    return (await this.all()).filter((point) =>
      [point.area, point.station, point.municipality].some((value) =>
        value.toLocaleLowerCase("ja").includes(normalized),
      ),
    );
  }
}

async function readGcs(uri: string): Promise<string> {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error("LAND_PRICE_DATA_PATH must be gs://bucket/object");
  const [, bucket, object] = match;
  const [bytes] = await new Storage().bucket(bucket!).file(object!).download();
  return bytes.toString("utf8");
}

function validatePoint(raw: unknown): LandPricePoint {
  if (!raw || typeof raw !== "object") throw new Error("Invalid land price row");
  const row = raw as Record<string, unknown>;
  const requiredStrings = ["id", "area", "station", "municipality", "source", "sourceUrl", "observedAt"];
  for (const key of requiredStrings) {
    if (typeof row[key] !== "string") throw new Error(`Invalid land price field: ${key}`);
  }
  const requiredNumbers = ["lat", "lng", "pricePerSqm", "previousPricePerSqm", "stationWalkMinutes"];
  for (const key of requiredNumbers) {
    if (typeof row[key] !== "number" || !Number.isFinite(row[key])) throw new Error(`Invalid land price field: ${key}`);
  }
  return row as unknown as LandPricePoint;
}
