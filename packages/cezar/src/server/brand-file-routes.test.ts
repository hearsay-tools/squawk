import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerBrandFileRoutes } from './brand-file-routes.ts';
import { resolveGetRequest } from './static-ui.ts';

function app(): Hono {
  const hono = new Hono();
  registerBrandFileRoutes(hono, (name, type) => () => new Response(name, { headers: { 'content-type': type } }));
  return hono;
}

describe('registerBrandFileRoutes', () => {
  it('serves the web app manifest as JSON scoped to the whole cockpit', async () => {
    const response = await app().request('/manifest.webmanifest');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/manifest+json');
    expect(await response.json()).toMatchObject({ scope: '/', start_url: '/', display: 'standalone' });
  });

  it('serves the home-screen icon from the build as a PNG', async () => {
    const response = await app().request('/app-icon.png');
    expect(await response.text()).toBe('app-icon.png');
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('keeps every registered path out of the shell catch-all', () => {
    const paths = app().routes.map((route) => route.path);
    expect(paths.filter((path) => resolveGetRequest({ path, distExists: true }) !== 'passthrough')).toEqual([]);
  });
});
