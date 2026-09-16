import { GoogleAuth } from 'google-auth-library';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

/** Download a generation-pinned, checksum-verified snapshot before serving requests. */
export async function prepareSnapshot() {
  const uri = process.env.PLACES_SNAPSHOT_URI;
  if (!uri) return;
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new Error('PLACES_SNAPSHOT_URI must be a gs://bucket/object URI');
  const path = process.env.LOCAL_PLACES_SQLITE || '/tmp/geo/places.sqlite';
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_only'] }).getClient();
  const headers = await client.getRequestHeaders();
  const endpoint = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(match[1]!)}/o/${encodeURIComponent(match[2]!)}`;
  const metadataResponse = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30_000) });
  if (!metadataResponse.ok) throw new Error(`Snapshot metadata: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json() as { generation: string; size: string; md5Hash?: string };
  const size = Number(metadata.size);
  if (!metadata.md5Hash || !Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024 * 1024) throw new Error('Snapshot must have a checksum and be between 1 byte and 512 MiB');
  await mkdir(dirname(path), { recursive: true });
  const response = await fetch(`${endpoint}?alt=media&generation=${encodeURIComponent(metadata.generation)}`, { headers, signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Snapshot download: HTTP ${response.status}`);
  const hash = createHash('md5');
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > size) throw new Error('Snapshot larger than advertised');
      hash.update(chunk);
      yield chunk;
    }
  }, createWriteStream(path + '.next'));
  if (bytes !== size || hash.digest('base64') !== metadata.md5Hash) throw new Error('Snapshot checksum mismatch');
  await rename(path + '.next', path);
  process.env.LOCAL_PLACES_SQLITE = path;
}
