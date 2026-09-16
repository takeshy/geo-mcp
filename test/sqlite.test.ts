import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqlitePlaceProvider } from '../src/sqlite-places.js';
import { createGeoMcpServer } from '../src/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('portable snapshot supports Japanese names, category OR, hours, radius and literal search', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-sqlite-'));
  const path = join(dir, 'places.sqlite');
  const records = [
    { osm_id: 1, name: 'Tokyo Station', name_ja: '東京駅', lat: 35.681, lng: 139.767 },
    { osm_id: 2, name: '近い薬局', shop: 'chemist', lat: 35.6811, lng: 139.767, opening_hours: '24/7' },
    { osm_id: 3, name: '遠い薬局', amenity: 'pharmacy', lat: 35.685, lng: 139.767 },
    { osm_id: 4, name: '範囲外薬局', amenity: 'pharmacy', lat: 35.9, lng: 139.767 },
    { osm_id: 5, name: '100%_カフェ', lat: 35.681, lng: 139.767 },
  ].map(r => JSON.stringify({ osm_type: 'node', ...r })).join('\n');
  const built = spawnSync('python3', ['ops/cloud-run/snapshot.py', path], { input: records, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const provider = new SqlitePlaceProvider(path);
  try {
    assert.equal((await provider.search({ query: '東京駅' }))[0]?.name, '東京駅');
    assert.equal((await provider.search({ query: '東京' }))[0]?.name, '東京駅');
    assert.equal((await provider.search({ query: '%_' })).length, 1);
    const nearby = await provider.search({ query: '薬局', lat: 35.681, lng: 139.767, radius: 1000 });
    assert.deepEqual(nearby.map(p => p.name), ['近い薬局', '遠い薬局']);
    assert.equal(nearby[0]?.openingHours, '24/7');
    assert.ok(nearby[0]!.distanceMetres! < nearby[1]!.distanceMetres!);
    assert.equal((await provider.search({ query: '薬局', lat: 35.681, lng: 139.767, radius: 100 })).length, 1);
    assert.equal((await provider.search({ query: "' OR 1=1 --" })).length, 0);
  } finally { provider.close(); rmSync(dir, { recursive: true }); }
});

test('MCP exposes only place_search and route', async () => {
  const server = createGeoMcpServer();
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['place_search', 'route']);
  } finally { await client.close(); await server.close(); }
});
