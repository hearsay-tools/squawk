/** The cockpit's web app manifest, for "Add to Home Screen" on a phone.
 *
 *  `scope: '/'` is the reason this file exists. Without a manifest a home-screen app's scope is
 *  the folder of the page the user added, such as `/p/<boot>/`. Opening another project
 *  (`/p/<other>/`) then leaves the scope, and the phone shows browser chrome over the app.
 *  `start_url: '/'` lands on the boot project, as the root route does in a browser tab. */

/** Dark is the default theme. The splash uses `--surface-base` and the status bar uses `--card`
 *  (packages/web/src/styles/index.css); the page's theme-color meta then follows the stored theme. */
const DARK_SURFACE = '#18191b';
const DARK_CARD = '#202224';

export type WebAppManifest = {
  name: string;
  short_name: string;
  id: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

export function webAppManifest(displayName: string): WebAppManifest {
  return {
    name: displayName,
    short_name: displayName,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: DARK_SURFACE,
    theme_color: DARK_CARD,
    icons: [
      { src: '/app-icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/cezarion-mark-dark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
