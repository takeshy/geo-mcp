import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.env.GEO_MCP_GATEWAY_URL;
const key = process.env.MCP_GATEWAY_API_KEY;
assert.ok(endpoint && key, 'Set GEO_MCP_GATEWAY_URL and MCP_GATEWAY_API_KEY');
const marker = `gateway-check-${randomUUID()}`;
const origin = new URL(endpoint).origin;
for (const [path, method, headers] of [
  ['/mcp', 'POST', {}],
  ['/mcp', 'POST', { 'X-API-Key': 'invalid-key' }],
  ['/.env', 'GET', { 'X-API-Key': key }],
  ['/.git/config', 'GET', { 'X-API-Key': key }],
  ['/health', 'GET', { 'X-API-Key': key }],
  ['/mcp', 'PUT', { 'X-API-Key': key }],
]) {
  const response = await fetch(`${origin}${path}?check=${marker}`, {
    method, headers, redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  assert.ok([400, 401, 403, 404, 405].includes(response.status), `${method} ${path}: ${response.status}`);
  await response.arrayBuffer();
  console.log(`Blocked: ${method} ${path} (${response.status})`);
}
console.log(`Negative request marker: ${marker}`);

const client = new Client({ name: 'geo-gateway-check', version: '1' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { 'X-API-Key': key } },
});
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['place_search', 'reverse_geocode', 'route']);
  assert.deepEqual(tools.find(t => t.name === 'route').inputSchema.properties.mode.enum, ['driving', 'walking']);
  console.log('MCP initialize and tools/list: passed');
  for (const [label, lat, lng, countryCode] of [
    ['Tokyo', 35.6812, 139.7671, 'JP'],
    ['French village', 44.057, 3.419, 'FR'],
    ['Fiji', -16.8, 179.99, 'FJ'],
  ]) {
    const answer = await client.callTool({ name: 'reverse_geocode', arguments: { lat, lng } }, undefined, { timeout: 300000 });
    assert.ok(!answer.isError, JSON.stringify(answer.content));
    assert.equal(answer.structuredContent.source, 'local');
    assert.equal(answer.structuredContent.provider, 'geonames');
    assert.equal(answer.structuredContent.found, true);
    assert.equal(answer.structuredContent.place.countryCode, countryCode);
    console.log(`${label}: ${answer.structuredContent.place.name}, ${answer.structuredContent.place.distanceMetres} m`);
  }
  const places = await client.callTool({ name: 'place_search', arguments: { query: 'カフェ', lat: 35.681, lng: 139.767, radius: 800 } }, undefined, { timeout: 300000 });
  assert.ok(!places.isError, JSON.stringify(places.content));
  assert.equal(places.structuredContent.source, 'local');
  console.log(`Local place search: ${places.structuredContent.places.length} results`);
  for (const mode of ['driving', 'walking']) {
    const answer = await client.callTool({ name: 'route', arguments: { lat: 35.531, lng: 139.697, toLat: 35.681, toLng: 139.767, mode } }, undefined, { timeout: 300000 });
    assert.ok(!answer.isError, JSON.stringify(answer.content));
    assert.equal(answer.structuredContent.source, 'local');
    assert.ok(answer.structuredContent.distanceKm > 0);
    console.log(`${mode}: local, ${answer.structuredContent.distanceKm} km, ${answer.structuredContent.durationMinutes} minutes`);
  }
} finally {
  await client.close();
}
