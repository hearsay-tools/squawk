/**
 * Non-RPC HTTP route registry for bundled features and plugins (hearsay-tools/squawk#4402).
 * Follows the register → seal → read lifecycle of `core/registry.ts`. Routes mounted here sit
 * outside `AppType` RPC inference, behind the global `/api/*` request-origin guard and before the
 * SPA catch-all.
 */
import type { Home } from '../home/home.ts';
import { createKeyedRegistry } from './registry.ts';

export const HTTP_ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'] as const;
export type HttpRouteMethod = typeof HTTP_ROUTE_METHODS[number];

export interface HttpRouteContext {
  readonly home: Home;
  readonly version: string;
  readonly squawkPort: () => number | undefined;
  readonly isHostedMode: () => boolean;
  /** Invoke the cockpit HTTP app in-process (synthetic loopback Host, no Origin). */
  fetchApp(request: Request): Promise<Response>;
}

export interface HttpRouteDefinition {
  readonly id: string;
  readonly method: HttpRouteMethod;
  /** Must start with `/api/v1/`. */
  readonly path: string;
  /** Optional stricter body byte cap enforced before the global 32 MiB bodyLimit middleware. */
  readonly maxBodyBytes?: number | undefined;
  handle(request: Request, context: HttpRouteContext): Response | Promise<Response>;
}

const API_V1_PREFIX = '/api/v1/';

const routes = createKeyedRegistry<string, HttpRouteDefinition>({
  name: 'HTTP routes',
  bootHint: 'register every HTTP route, then call sealHttpRoutes() at the runtime boot boundary (boot.ts), or import a testkit that seals it.',
});

const claimedPaths = new Map<string, HttpRouteDefinition>();

function checkShape(route: HttpRouteDefinition): void {
  if (typeof route !== 'object' || route === null) throw new Error('HTTP routes: a route definition must be an object.');
  if (typeof route.id !== 'string' || route.id.length === 0) throw new Error(`HTTP routes: invalid id ${JSON.stringify(route.id)}.`);
  if (!(HTTP_ROUTE_METHODS as readonly string[]).includes(route.method)) {
    throw new Error(`HTTP routes: '${route.id}' has unsupported method ${JSON.stringify(route.method)}.`);
  }
  if (typeof route.path !== 'string' || !route.path.startsWith(API_V1_PREFIX) || route.path.length <= API_V1_PREFIX.length) {
    throw new Error(`HTTP routes: '${route.id}' path must start with '${API_V1_PREFIX}', got ${JSON.stringify(route.path)}.`);
  }
  if (route.maxBodyBytes !== undefined && (!Number.isSafeInteger(route.maxBodyBytes) || route.maxBodyBytes <= 0)) {
    throw new Error(`HTTP routes: '${route.id}' maxBodyBytes must be a positive integer.`);
  }
  if (typeof route.handle !== 'function') throw new Error(`HTTP routes: '${route.id}' needs a handle function.`);
}

/** Throws what `registerHttpRoute` would throw, without writing. */
export function checkHttpRouteRegistration(route: HttpRouteDefinition): void {
  checkShape(route);
  routes.check(route.id, route);
  const owner = claimedPaths.get(route.path);
  if (owner !== undefined && owner !== route) {
    throw new Error(`HTTP routes: path '${route.path}' is already registered by '${owner.id}'.`);
  }
}

export function registerHttpRoute(route: HttpRouteDefinition): void {
  checkHttpRouteRegistration(route);
  routes.register(route.id, route);
  claimedPaths.set(route.path, route);
}

export function sealHttpRoutes(): void { routes.seal(); }

/** Whether the registry is sealed. Never throws. */
export function httpRoutesSealed(): boolean { return routes.isSealed(); }

/** Registered plugin HTTP routes in registration order. Throws until sealed. */
export function registeredHttpRoutes(): HttpRouteDefinition[] {
  return routes.values();
}
