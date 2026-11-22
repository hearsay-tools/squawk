import type { Context, Hono } from 'hono';
import { productIdentity } from '../home/identity.ts';
import { webAppManifest } from './web-app-manifest.ts';

type StaticFile = (name: string, type: string) => (c: Context) => Response | Promise<Response>;

/** The fixed-name files of the web build: the brand marks and the home-screen install pair.
 *  `staticFile` reads each one from `web/dist`. static-ui.ts lists the same paths, so the shell
 *  catch-all passes them through. */
export function registerBrandFileRoutes(app: Hono, staticFile: StaticFile): void {
  // The themed brand SVGs (#143): the sidebar lockup pair and the favicon pair. The cockpit
  // picks light or dark by its RESOLVED theme, so both files of each pair must be served —
  // a `<link media>` pair would follow the OS, which the stored theme can disagree with.
  app.get('/cezarion-lockup-light.svg', staticFile('cezarion-lockup-light.svg', 'image/svg+xml'));
  app.get('/cezarion-lockup-dark.svg', staticFile('cezarion-lockup-dark.svg', 'image/svg+xml'));
  app.get('/cezarion-mark-light.svg', staticFile('cezarion-mark-light.svg', 'image/svg+xml'));
  app.get('/cezarion-mark-dark.svg', staticFile('cezarion-mark-dark.svg', 'image/svg+xml'));
  // Home-screen install (web-app-manifest.ts): the manifest scopes the app to `/`, and the
  // opaque PNG is the iOS touch icon, which takes no SVG and paints transparent corners black.
  app.get('/app-icon.png', staticFile('app-icon.png', 'image/png'));
  app.get('/manifest.webmanifest', (c) =>
    c.body(JSON.stringify(webAppManifest(productIdentity().displayName)), 200, { 'content-type': 'application/manifest+json' }));
}
