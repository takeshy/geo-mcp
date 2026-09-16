import { prepareSnapshot } from "./snapshot.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authorize } from "./auth.js";
import { createGeoMcpServer } from "./mcp.js";

const port = Number(process.env.PORT || 8080);
const apiKey = process.env.MCP_API_KEY;
const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    setCommonHeaders(response);

    if (url.pathname === "/healthz" || url.pathname === "/health") return json(response, 200, { ok: true, service: "geo-home-mcp" });
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
  if (!authorize(request.headers.authorization, apiKey)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="geo-home-mcp"');
    return json(response, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <MCP_API_KEY>" } });
  }
  const mcp = createGeoMcpServer();
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

await prepareSnapshot();

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Geo Home MCP listening on http://0.0.0.0:${port}`);
  if (!(apiKey ?? "").trim()) console.warn("MCP_API_KEY is not set: /mcp accepts unauthenticated requests.");
});
