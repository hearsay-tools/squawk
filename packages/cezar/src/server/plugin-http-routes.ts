import type { Context, Hono } from 'hono';
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
