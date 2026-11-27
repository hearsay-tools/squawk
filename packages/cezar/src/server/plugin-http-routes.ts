import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  httpRoutesSealed,
  registeredHttpRoutes,
  type HttpRouteContext,
  type HttpRouteDefinition,
} from '../core/http-route-registry.ts';
import type { Home } from '../home/home.ts';

export interface MountPluginHttpRoutesInput {
  routed: Hono;
  home: Home;
  version: string;
  squawkPort?: (() => number | undefined) | undefined;
  isHostedMode: () => boolean;
  httpRoutes?: readonly HttpRouteDefinition[] | undefined;
}

/**
 * Register per-route body limits BEFORE the global 32 MiB `bodyLimit` middleware so chunked
 * streaming uploads to stricter routes (like `/api/v1/mcp` at 1 MiB) fail at their own cap.
 * Returns the paths already gated here so the global middleware can skip double-buffering them.
 */
export function mountPluginHttpRouteLimits(
  app: Hono,
  httpRoutes?: readonly HttpRouteDefinition[],
): ReadonlySet<string> {
  const routes = httpRoutes ?? (httpRoutesSealed() ? registeredHttpRoutes() : []);
  const limitedPaths = new Set<string>();
  for (const route of routes) {
    if (route.maxBodyBytes === undefined) continue;
    const limit = route.maxBodyBytes;
    limitedPaths.add(route.path);
    app.use(route.path, bodyLimit({
      maxSize: limit,
      onError: (c) => c.json({ error: `request body exceeds ${limit} byte limit` }, 413),
    }));
  }
  return limitedPaths;
}

/**
 * Mount non-RPC plugin HTTP routes (hearsay-tools/squawk#4402) outside the `AppType` RPC
 * chain, after the global `/api/*` request-origin guard and before the SPA catch-all.
 */
export function mountPluginHttpRoutes(input: MountPluginHttpRoutesInput): void {
  const pluginHttpRoutes = input.httpRoutes ?? (httpRoutesSealed() ? registeredHttpRoutes() : []);
  if (pluginHttpRoutes.length === 0) return;

  const fetchApp = async (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.delete('origin');
    headers.delete('sec-fetch-site');
    headers.set('host', '127.0.0.1');
    const body = request.body !== null ? await request.arrayBuffer() : undefined;
    const internal = new Request(request.url, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: request.signal,
    });
    return input.routed.fetch(internal);
  };

  const routeContext: HttpRouteContext = {
    home: input.home,
    version: input.version,
    squawkPort: () => input.squawkPort?.(),
    isHostedMode: input.isHostedMode,
    fetchApp,
  };

  for (const route of pluginHttpRoutes) {
    const handler = (c: Context) => route.handle(c.req.raw, routeContext);
    if (route.method === 'ALL') input.routed.all(route.path, handler);
    else input.routed.on(route.method, route.path, handler);
  }
}
