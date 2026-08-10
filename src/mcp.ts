import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeCommute } from "./commute.js";
import { LandPriceRepository } from "./data.js";
import { findCandidates } from "./search.js";
import type { CandidateSearchInput, Coordinate } from "./types.js";

const UI_URI = "ui://geo-home-mcp/land-price-map.html";
const mapHtmlUrl = new URL("../public/map.html", import.meta.url);

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90).describe("Latitude"),
  lng: z.number().min(-180).max(180).describe("Longitude"),
  name: z.string().optional().describe("Human-readable place name"),
});

const searchSchema = {
  destination: coordinateSchema.describe("Commute destination"),
  maxCommuteMinutes: z.number().int().min(5).max(180).default(60),
  maxPricePerSqm: z.number().positive().optional().describe("Maximum land price in JPY per square metre"),
  maxStationWalkMinutes: z.number().int().min(1).max(60).default(20),
  limit: z.number().int().min(1).max(30).default(10),
  arrivalTime: z.string().datetime().optional().describe("ISO 8601 desired arrival time"),
};

export function createGeoMcpServer(repository = new LandPriceRepository()): McpServer {
  const server = new McpServer({ name: "geo-home-mcp", version: "0.1.0" });

  server.registerResource(
    "land-price-map",
    new ResourceTemplate(UI_URI, { list: undefined }),
    { title: "地価・移動時間マップ", description: "Interactive candidate-area map", mimeType: "text/html" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/html", text: await readFile(fileURLToPath(mapHtmlUrl), "utf8") }],
    }),
  );

  server.registerTool(
    "list_layers",
    { description: "List available geographic datasets, provenance, and freshness." },
    async () => jsonResult({
      layers: [
        {
          id: "land-price",
          title: "地価ポイント",
          source: process.env.LAND_PRICE_DATA_PATH ? "configured dataset" : "bundled demonstration data",
          observedAt: "2026-01-01",
          warning: process.env.LAND_PRICE_DATA_PATH ? undefined : "Values are illustrative and must not be used for a purchase decision.",
        },
        {
          id: "commute-time",
          title: "公共交通所要時間",
          source: "precomputed open transit profiles with straight-line fallback",
        },
        ...(process.env.PMTILES_URL ? [{ id: "pmtiles", title: "Configured PMTiles layer", source: process.env.PMTILES_URL }] : []),
      ],
    }),
  );

  server.registerTool(
    "get_land_price",
    {
      description: "Get land-price observations for an area, station, or municipality with source provenance.",
      inputSchema: { query: z.string().min(1).max(100) },
    },
    async ({ query }) => jsonResult({ query, observations: await repository.byArea(query) }),
  );

  server.registerTool(
    "compute_commute",
    {
      description: "Compute travel time from bundled precomputed transit profiles, with a clearly marked estimate fallback.",
      inputSchema: {
        origin: coordinateSchema,
        destination: coordinateSchema,
        arrivalTime: z.string().datetime().optional(),
      },
    },
    async ({ origin, destination, arrivalTime }) => jsonResult({
      origin,
      destination,
      commute: await computeCommute(origin, destination, arrivalTime),
    }),
  );

  server.registerTool(
    "find_candidate_areas",
    {
      description: "Rank residential areas by land price, commute duration, and station walking time.",
      inputSchema: searchSchema,
    },
    async (input) => {
      const candidates = await findCandidates(await repository.all(), input as CandidateSearchInput);
      return jsonResult({ criteria: input, candidates, disclaimer: disclaimer(candidates) });
    },
  );

  server.registerTool(
    "compare_areas",
    {
      description: "Compare named areas using land-price observations and commute time to one destination.",
      inputSchema: {
        areas: z.array(z.string().min(1)).min(2).max(10),
        destination: coordinateSchema,
        arrivalTime: z.string().datetime().optional(),
      },
    },
    async ({ areas, destination, arrivalTime }) => {
      const rows = await Promise.all(areas.map(async (area) => {
        const observations = await repository.byArea(area);
        const point = observations[0];
        return point ? { ...point, commute: await computeCommute(point, destination, arrivalTime, point.commuteProfiles) } : { area, error: "No observation found" };
      }));
      return jsonResult({ destination, comparisons: rows });
    },
  );

  server.registerTool(
    "build_area_map",
    {
      description: "Build an interactive PMTiles/MapLibre map of land-price and commute candidates. Call this after candidate searches so users can inspect locations visually.",
      inputSchema: searchSchema,
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async (input) => {
      const candidates = await findCandidates(await repository.all(), input as CandidateSearchInput);
      const structuredContent = {
        title: `${input.destination.name || "目的地"}への通勤圏と地価`,
        criteria: input,
        candidates,
        destination: input.destination,
        pmtilesUrl: process.env.PMTILES_URL || null,
        pmtilesSourceLayer: process.env.PMTILES_SOURCE_LAYER || "land-price",
        basemapStyleUrl: process.env.BASEMAP_STYLE_URL || "https://tiles.openfreemap.org/styles/bright",
        disclaimer: disclaimer(candidates),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
        _meta: { ui: { resourceUri: UI_URI } },
      };
    },
  );

  return server;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function disclaimer(candidates: Array<{ commute: { mode: string } }>): string[] {
  const messages = ["地価は土地・建物の購入総額ではありません。接道、形状、建築条件などは個別確認が必要です。"];
  if (candidates.some((candidate) => candidate.commute.mode === "estimate")) {
    messages.push("一致する事前計算済み公共交通プロファイルがない地点は、直線距離によるデモ推定です。");
  }
  if (!process.env.LAND_PRICE_DATA_PATH) messages.push("表示中の地価はデモ値であり、実際の購入判断には使用できません。");
  return messages;
}

export const defaultDestination: Coordinate & { name: string } = { name: "東京駅", lat: 35.6812, lng: 139.7671 };
