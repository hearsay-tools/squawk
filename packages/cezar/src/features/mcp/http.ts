/**
 * Stateless Streamable HTTP MCP endpoint (`/api/v1/mcp`, hearsay-tools/squawk#4402).
 *
 * Security invariants (after the global `/api/*` loopback-Host check in local mode; skips global
 * 32 MiB `bodyLimit` buffering via `managesBodyLimit: true`):
 * 1. Reject any request carrying an `Origin` header (`403`) before reading the body.
 * 2. Fail closed (`404`) when no MCP bearer token is configured for this port or env.
 * 3. Require `Authorization: Bearer <token>` verified via SHA-256 + `crypto.timingSafeEqual`
 *    (`401` + `WWW-Authenticate: Bearer` on missing, invalid, or Basic auth) before reading the body.
 * 4. Allow `POST` only (`405` + `Allow: POST` on `GET`/`DELETE`/other methods).
 * 5. Enforce a 1 MiB streaming request body limit (`413`) on authenticated `POST`s.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { HttpRouteContext, HttpRouteDefinition } from '../../core/http-route-registry.ts';
import { registerRuntimeSecret } from '../../core/secret-redaction.ts';
import { authenticateMcpRequest } from '../../mcp-tokens.ts';
import type { FetchFn } from '../../task-cli/http.ts';
import { createOrchestratorMcpServer } from './tools.ts';

export const MCP_HTTP_ROUTE_ID = 'mcp';
export const MCP_HTTP_PATH = '/api/v1/mcp';
export const MCP_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
export const MCP_KEEP_ALIVE_MS = 15_000;

export interface McpHttpHandlerOptions {
  env?: NodeJS.ProcessEnv | undefined;
  pollMs?: number | undefined;
  heartbeatMs?: number | undefined;
  keepAliveMs?: number | undefined;
}

/** Parse `Authorization: Bearer <token>`. Rejects missing, Basic, empty, or multi-word headers. */
export function parseBearerHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Read a request body up to `maxBytes`. Returns `null` when the payload exceeds the cap. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return null;
    }
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function wrapStreamCleanup(body: ReadableStream<Uint8Array>, onDone: () => void): ReadableStream<Uint8Array> {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* stream already closed */ }
      finish();
    },
  });
}

function firstHeaderToken(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first ? first : null;
}

function parseRequestUrl(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

function parseOriginAuthority(proto: 'http' | 'https', rawHost: string | null): string | null {
  if (!rawHost || /[\s/@\\]/.test(rawHost)) return null;
  const parsed = parseRequestUrl(`${proto}://${rawHost}`);
  if (!parsed) return null;
  const hasExtras = Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  return hasExtras || parsed.pathname !== '/' ? null : parsed.origin;
}

/**
 * Resolve the cockpit origin returned in MCP task URLs. Behind a hosted reverse proxy, honor
 * `X-Forwarded-Proto` and `X-Forwarded-Host` (falling back to `Host`); in local mode, ignore
 * forwarded headers and use the loopback request host. Invalid authorities fall back safely.
 */
export function resolvePublicOrigin(request: Request, context: HttpRouteContext, loopbackOrigin: string): string {
  const requestUrl = parseRequestUrl(request.url);
  const hosted = context.isHostedMode();
  const forwardedProto = hosted ? firstHeaderToken(request.headers.get('x-forwarded-proto'))?.toLowerCase() : undefined;
  const proto: 'http' | 'https' = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : requestUrl?.protocol === 'https:' ? 'https' : 'http';
  const rawHost = (hosted ? firstHeaderToken(request.headers.get('x-forwarded-host')) : null)
    ?? firstHeaderToken(request.headers.get('host'))
    ?? requestUrl?.host
    ?? null;
  return parseOriginAuthority(proto, rawHost) ?? loopbackOrigin;
}

function unauthorizedResponse(): Response {
  return Response.json(
    { error: 'unauthorized: valid Bearer token required' },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
  );
}

/** Handle one HTTP request to `/api/v1/mcp`. */
export async function handleMcpHttpRequest(
  request: Request,
  context: HttpRouteContext,
  options: McpHttpHandlerOptions = {},
): Promise<Response> {
  if (request.headers.get('origin') !== null) {
    return Response.json(
      { error: 'forbidden: Origin header is not allowed on /api/v1/mcp' },
      { status: 403 },
    );
  }

  const env = options.env ?? process.env;
  const port = context.squawkPort();
  const rawToken = parseBearerHeader(request.headers.get('authorization'));
  const auth = authenticateMcpRequest(rawToken, env, port, context.home);
  if (auth.status === 'unconfigured') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  if (auth.status === 'unauthorized') {
    return unauthorizedResponse();
  }
  const verified = auth.verified;
  if (rawToken) registerRuntimeSecret(rawToken);

  if (request.method !== 'POST') {
    return Response.json(
      { error: 'method not allowed: use POST /api/v1/mcp' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }

  const bodyBytes = await readBoundedBody(request, MCP_MAX_BODY_BYTES);
  if (bodyBytes === null) {
    return Response.json(
      { error: 'request body exceeds 1 MiB limit' },
      { status: 413 },
    );
  }

  const abortController = new AbortController();
  const onRequestAbort = () => abortController.abort(request.signal.reason);
  if (request.signal.aborted) onRequestAbort();
  else request.signal.addEventListener('abort', onRequestAbort, { once: true });

  const loopbackOrigin = port !== undefined ? `http://127.0.0.1:${port}` : 'http://127.0.0.1';
  const publicOrigin = resolvePublicOrigin(request, context, loopbackOrigin);
  const inProcessFetch: FetchFn = (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(rawUrl, loopbackOrigin);
    const internalUrl = `${loopbackOrigin}${target.pathname}${target.search}`;
    return context.fetchApp(new Request(internalUrl, init));
  };

  const server = createOrchestratorMcpServer({
    origin: publicOrigin,
    version: context.version,
    fetch: inProcessFetch,
    allowedProject: verified.project,
    requestSignal: abortController.signal,
    pollMs: options.pollMs,
    heartbeatMs: options.heartbeatMs,
  });
  // Stateless mode: omit sessionIdGenerator so no Mcp-Session-Id is issued.
  const transport = new WebStandardStreamableHTTPServerTransport({
    keepAliveMs: options.keepAliveMs ?? MCP_KEEP_ALIVE_MS,
  });

  const cleanup = () => {
    request.signal.removeEventListener('abort', onRequestAbort);
    if (!abortController.signal.aborted) abortController.abort();
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  };

  try {
    await server.connect(transport);
    const forwarded = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: bodyBytes ?? new Uint8Array(0),
    });
    const response = await transport.handleRequest(forwarded);
    const isSse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    if (isSse && response.body) {
      return new Response(wrapStreamCleanup(response.body, cleanup), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    cleanup();
    return response;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function createMcpHttpRoute(options: McpHttpHandlerOptions = {}): HttpRouteDefinition {
  return {
    id: MCP_HTTP_ROUTE_ID,
    method: 'ALL',
    path: MCP_HTTP_PATH,
    managesBodyLimit: true,
    handle: (request, context) => handleMcpHttpRequest(request, context, options),
  };
}

export const mcpHttpRoute: HttpRouteDefinition = createMcpHttpRoute();
