import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlaceError, placeSearch, route, type PlaceAnswer } from "./places.js";

export function createGeoMcpServer(): McpServer {
  const server = new McpServer({ name: "geo-home-mcp", version: "0.1.0" });
  server.registerTool(
    "place_search",
    {
      description: "指定した位置の周りの店や施設を探す（OpenStreetMap）。lat/lngを渡すと半径内を距離順に、なければ名前だけで検索する（現在地周辺とは限らない）。営業時間は地図に登録がある場合だけ返り、営業中かは保証しない。混雑・取得失敗はエラーになり、検索結果なしとは区別する。",
      inputSchema: {
        query: z.string().min(1).max(100).describe("探すもの。店名やラーメン・カフェなど"),
        lat: z.number().min(-90).max(90).optional().describe("周りを探す位置の緯度（北緯）"),
        lng: z.number().min(-180).max(180).optional().describe("周りを探す位置の経度（東経）"),
        radius: z.number().positive().max(5000).optional().describe("半径メートル。既定1200"),
      },
    },
    async (input) => placeResult(() => placeSearch(input)),
  );

  server.registerTool(
    "route",
    {
      description: "指定した位置から目的地までの道路の所要時間と距離（OSRM）。目的地は名前またはtoLat/toLngで渡す。公共交通・リアルタイムの渋滞は非対応。",
      inputSchema: {
        toLat: z.number().min(-90).max(90).optional(),
        toLng: z.number().min(-180).max(180).optional(),
        to: z.string().min(1).max(200).optional().describe("目的地の名前。例: 渋谷駅"),
        lat: z.number().min(-90).max(90).describe("出発位置の緯度（北緯）"),
        lng: z.number().min(-180).max(180).describe("出発位置の経度（東経）"),
        mode: z.enum(["driving", "walking", "cycling"]).optional().describe("移動手段。既定driving"),
      },
    },
    async (input) => placeResult(() => route(input)),
  );

  return server;
}

// placeResult hands the model the text, keeps the data as structuredContent and
// turns each source into a resource_link so a client can cite it. A map service
// failure comes back as an error result, never as an empty answer.
async function placeResult(answer: () => Promise<PlaceAnswer>) {
  try {
    const { text, data, links } = await answer();
    return {
      content: [
        { type: "text" as const, text },
        ...links.map((link) => ({ type: "resource_link" as const, uri: link.url, name: link.label, title: link.label })),
      ],
      structuredContent: data,
    };
  } catch (error) {
    const message = error instanceof PlaceError ? error.message : `地図サービスの呼び出しに失敗しました: ${error instanceof Error ? error.message : String(error)}`;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}
