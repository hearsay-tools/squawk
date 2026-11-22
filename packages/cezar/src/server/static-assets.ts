import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

const zip = promisify(gzip);
const brotli = promisify(brotliCompress);
type Encoding = 'br' | 'gzip';
type Asset = { raw: Buffer; encoded: Map<Encoding, Buffer> };

/** Respect explicit exclusions, wildcard qualities and relative preferences. */
function encoding(header: string): Encoding | undefined {
  const qualities = new Map(header.toLowerCase().split(',').map((part) => {
    const [name, ...params] = part.trim().split(';');
    const q = params.find((p) => p.trim().startsWith('q='));
    const value = q ? Number(q.trim().slice(2)) : 1;
    return [name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0];
  }));
  const quality = (name: Encoding) => qualities.get(name) ?? qualities.get('*') ?? 0;
  return (['br', 'gzip'] as const).filter((name) => quality(name) > 0)
    .sort((a, b) => quality(b) - quality(a))[0];
}

function compressible(request: Request, response: Response): boolean {
  const type = response.headers.get('content-type') ?? '';
  return request.method !== 'HEAD' && !request.headers.has('upgrade') &&
    response.status !== 204 && response.status !== 304 && response.status !== 206 &&
    !response.headers.has('content-encoding') && !response.headers.has('content-range') &&
    !/\bno-transform\b/i.test(response.headers.get('cache-control') ?? '') &&
    /^(text\/(?!event-stream\b)|application\/(?:json|[^;]+\+json|javascript)\b)/i.test(type);
}

async function compressed(raw: Buffer, coding: Encoding): Promise<Buffer> {
  return coding === 'gzip' ? zip(raw) : brotli(raw, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  });
}

async function encode(request: Request, response: Response, asset?: Asset): Promise<Response> {
  if (!compressible(request, response)) return response;
  // Vary on identity responses too: a shared cache must not hide the encoded variant.
  const headers = new Headers(response.headers);
  const vary = headers.get('vary');
  if (!vary?.split(',').some((v) => /^(\*|accept-encoding)$/i.test(v.trim()))) {
    headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  }
  const coding = encoding(request.headers.get('accept-encoding') ?? '');
  if (!coding) return new Response(response.body, { status: response.status, headers });
  const raw = asset?.raw ?? Buffer.from(await response.arrayBuffer());
  if (raw.length < 1024) return new Response(raw, { status: response.status, headers });
  let body = asset?.encoded.get(coding);
  if (!body) {
    body = await compressed(raw, coding);
    asset?.encoded.set(coding, body);
  }
  headers.set('content-encoding', coding);
  headers.delete('content-length');
  return new Response(body, { status: response.status, headers });
}

export const compression: MiddlewareHandler = async (c, next) => {
  await next();
  const response = await encode(c.req.raw, c.res);
  if (response === c.res) return;
  // Hono copies old headers onto replacements; remove the values encode changed.
  c.res.headers.delete('content-length');
  c.res.headers.delete('vary');
  c.res = response;
};

export async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Async reads for live files; immutable bundles retain raw and compressed bytes in one LRU. */
export function createStaticAssets(limit = 32 * 1024 * 1024) {
  const cache = new Map<string, Asset>();
  const size = (asset: Asset) => asset.raw.length + [...asset.encoded.values()].reduce((n, b) => n + b.length, 0);
  const trim = () => {
    let bytes = [...cache.values()].reduce((n, asset) => n + size(asset), 0);
    for (const [key, asset] of cache) {
      if (bytes <= limit) break;
      cache.delete(key);
      bytes -= size(asset);
    }
  };
  return async (request: Request, path: string, headers: Record<string, string>, immutable = false): Promise<Response> => {
    let asset = immutable ? cache.get(path) : undefined;
    if (!asset) {
      try {
        if (!await isFile(path)) return Response.json({ error: 'not found' }, { status: 404 });
        asset = { raw: await readFile(path), encoded: new Map() };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return Response.json({ error: 'not found' }, { status: 404 });
      }
    }
    const response = await encode(request, new Response(asset.raw, { headers }), asset);
    if (immutable) {
      cache.delete(path);
      cache.set(path, asset);
      trim();
    }
    return response;
  };
}
