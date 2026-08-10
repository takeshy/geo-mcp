import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const endpoint = process.argv[2]?.trim();
if (!endpoint) {
  console.error("Usage: node scripts/configure-plugin-url.mjs https://SERVICE.run.app/mcp");
  process.exit(1);
}

const url = new URL(endpoint);
if (url.protocol !== "https:" || url.pathname !== "/mcp" || url.search || url.hash) {
  throw new Error("Endpoint must be an HTTPS URL ending in /mcp without query or fragment");
}

const root = fileURLToPath(new URL("../", import.meta.url));
await updateJson(new URL("mcp.json", new URL("../", import.meta.url)), (document) => {
  document.mcpServers["geo-home"].url = url.href;
});
await updateJson(new URL(".mcp.json", new URL("../", import.meta.url)), (document) => {
  document.mcpServers["geo-home"].url = url.href;
});

console.log(`Configured Agent Plugin MCP endpoint: ${url.href}`);
console.log(`Updated ${root}mcp.json and ${root}.mcp.json`);

async function updateJson(file, mutate) {
  const document = JSON.parse(await readFile(file, "utf8"));
  mutate(document);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
}
