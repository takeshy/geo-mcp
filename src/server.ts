import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LandPriceRepository } from "./data.js";
import { createGeoMcpServer, defaultDestination } from "./mcp.js";
import { findCandidates } from "./search.js";

const port = Number(process.env.PORT || 8080);
const repository = new LandPriceRepository();
const mapPath = fileURLToPath(new URL("../public/map.html", import.meta.url));

const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    setCommonHeaders(response);

    if (url.pathname === "/healthz" || url.pathname === "/health") return json(response, 200, { ok: true, service: "geo-home-mcp" });
    if (url.pathname === "/" || url.pathname === "/map") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(await readFile(mapPath, "utf8"));
      return;
    }
    if (url.pathname === "/api/demo") {
      const candidates = await findCandidates(await repository.all(), {
        destination: defaultDestination,
        maxCommuteMinutes: 90,
        maxPricePerSqm: 450_000,
        maxStationWalkMinutes: 20,
        limit: 10,
      });
      return json(response, 200, {
        title: "東京駅への通勤圏と地価（デモ）",
        destination: defaultDestination,
        candidates,
        pmtilesUrl: process.env.PMTILES_URL || null,
        pmtilesSourceLayer: process.env.PMTILES_SOURCE_LAYER || "land-price",
        basemapStyleUrl: process.env.BASEMAP_STYLE_URL || "https://tiles.openfreemap.org/styles/bright",
        disclaimer: ["デモデータです。実際の購入判断には使用できません。"],
      });
    }
    if (url.pathname === "/mcp") return handleMcp(request, response);
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : "Internal server error" });
    else response.end();
  }
});

async function handleMcp(request: IncomingMessage, response: ServerResponse) {
  if (!["GET", "POST", "DELETE"].includes(request.method || "")) return json(response, 405, { error: "Method not allowed" });
  const mcp = createGeoMcpServer(repository);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(request, response);
}

function setCommonHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Geo Home MCP listening on http://0.0.0.0:${port}`);
});
