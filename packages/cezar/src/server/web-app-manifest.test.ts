import { describe, expect, it } from 'vitest';
import { webAppManifest } from './web-app-manifest.ts';

describe('webAppManifest', () => {
  it('scopes the home-screen app to the whole cockpit, so another project stays inside the app', () => {
    const manifest = webAppManifest('Squawk');
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('names the app with the product display name', () => {
    expect(webAppManifest('Squawk')).toMatchObject({ name: 'Squawk', short_name: 'Squawk' });
  });

  it('points every icon at a file the server serves', () => {
    expect(webAppManifest('Squawk').icons.map((icon) => icon.src)).toEqual(['/app-icon.png', '/cezarion-mark-dark.svg']);
  });
});
