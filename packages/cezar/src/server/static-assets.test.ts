import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';
import { compression, createStaticAssets } from './static-assets.ts';

const text = 'Squawk response '.repeat(200);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const request = (accept = 'gzip', method = 'GET', extra = {}) => new Request('http://localhost/', {
  method, headers: { 'accept-encoding': accept, ...extra },
});
function app(response: () => Response) {
  return new Hono().use('*', compression).all('*', () => response());
}

it.each([
  ['gzip', 'gzip'], ['br, gzip', 'br'], ['br;q=0.2,gzip;q=0.9', 'gzip'],
  ['br;q=0,*;q=1', 'gzip'], ['*;q=0', null], ['gzip;q=0,br;q=0', null], ['', null],
])('negotiates %s and preserves decoded bytes', async (accept, coding) => {
  const response = await app(() => new Response(text, { headers: {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'vary': 'Origin',
  } })).fetch(request(accept));
  expect(response.headers.get('content-encoding')).toBe(coding);
  expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(coding === 'br' ? brotliDecompressSync(bytes).toString() : coding === 'gzip' ? gunzipSync(bytes).toString() : bytes.toString()).toBe(text);
  if (coding) expect(response.headers.has('content-length')).toBe(false);
});

it.each([
  ['text/event-stream', {}, 'GET'], ['image/svg+xml', {}, 'GET'], ['font/woff2', {}, 'GET'],
  ['application/gzip', {}, 'GET'], ['text/plain', { 'content-encoding': 'custom' }, 'GET'],
  ['text/plain', {}, 'HEAD'], ['text/plain', { 'cache-control': 'no-transform' }, 'GET'],
])('leaves excluded %s response (%j, %s) untouched', async (type, headers, method) => {
  const response = await app(() => new Response(text, { headers: { 'content-type': type, ...headers } }))
    .fetch(request('gzip', method));
  expect(response.headers.get('content-encoding')).toBe('content-encoding' in headers ? headers['content-encoding'] : null);
});

it('does not consume an open SSE body or an upgrade response', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); } });
  const response = await app(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } })).fetch(request());
  expect(response.body).toBe(body);
  await response.body?.cancel();
  const upgrade = await app(() => new Response(text, { headers: { 'content-type': 'text/plain' } }))
    .fetch(request('gzip', 'GET', { upgrade: 'websocket' }));
  expect(upgrade.headers.has('content-encoding')).toBe(false);
});

it.each([204, 304])('leaves status %s bodyless', async (status) => {
  const response = await app(() => new Response(null, { status })).fetch(request());
  expect(response.status).toBe(status);
  expect(response.body).toBeNull();
  expect(response.headers.has('content-encoding')).toBe(false);
});

it('starts compression at 1024 bytes', async () => {
  for (const size of [1023, 1024]) {
    const response = await app(() => new Response('x'.repeat(size), { headers: { 'content-type': 'text/plain' } })).fetch(request());
    expect(response.headers.get('content-encoding')).toBe(size === 1024 ? 'gzip' : null);
  }
});

it('caches immutable raw, gzip and br bytes but keeps live files fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'static-assets-')); dirs.push(dir);
  const path = join(dir, 'index-abcdefgh.js');
  const serve = createStaticAssets();
  const headers = { 'content-type': 'text/javascript' };
  await writeFile(path, text);
  for (const accept of ['', 'gzip', 'br']) await serve(request(accept), path, headers, true);
  await rm(path);
  for (const accept of ['', 'gzip', 'br']) {
    const response = await serve(request(accept), path, headers, true);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(accept === 'br' ? brotliDecompressSync(bytes).toString() : accept === 'gzip' ? gunzipSync(bytes).toString() : bytes.toString()).toBe(text);
  }
  await writeFile(path, 'rebuilt');
  expect(await (await serve(request(), path, headers)).text()).toBe('rebuilt');
  await writeFile(path, 'rebuilt again');
  expect(await (await serve(request(), path, headers)).text()).toBe('rebuilt again');
});

it('counts compressed bytes toward the cap and evicts the least recently used file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'static-lru-')); dirs.push(dir);
  const headers = { 'content-type': 'text/plain' };
  const paths = [join(dir, 'a.js'), join(dir, 'b.js'), join(dir, 'c.js')] as const;
  await Promise.all(paths.map((path) => writeFile(path, text)));
  const serve = createStaticAssets(Buffer.byteLength(text) * 2);
  await serve(request(''), paths[0], headers, true);
  await serve(request(''), paths[1], headers, true);
  await serve(request('gzip'), paths[0], headers, true); // Promotes a; encoded bytes evict b.
  await rm(paths[1]);
  expect((await serve(request(), paths[1], headers, true)).status).toBe(404);
  await serve(request(''), paths[2], headers, true);
  await rm(paths[0]);
  expect((await serve(request(), paths[0], headers, true)).status).toBe(404);
  expect((await readFile(paths[2])).toString()).toBe(text);
});
