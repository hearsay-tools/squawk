import { describe, expect, it } from 'vitest';
import { findPackGaps, PLUGIN_ENTRY_FILES } from './pack-check.ts';
import { PLUGIN_ENTRY_SUBPATHS } from './plugin/resolve-hook.ts';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };

const RUNNERS = ['alpha', 'beta'];
const RUNNER_ENTRIES = RUNNERS.map(id => `dist/runners/${id}/index.js`);
/** `files` plus every plugin and runner entry, so a case about the UI sees only UI gaps. */
const withEntries = (files: readonly string[]) => [...files, ...PLUGIN_ENTRY_FILES, ...RUNNER_ENTRIES];

// The decision behind `npm run check:pack` (scripts/check-pack.mjs): would the
// npm tarball ship a working cockpit? Pins the R1 "npm pack shipped no UI" bug.
describe('findPackGaps', () => {
  const goodPack = withEntries([
    'README.md',
    'dist/index.js',
    'scripts/mock-claude.mjs',
    'web/dist/cezarion-mark-dark.svg',
    'web/dist/index.html',
    'web/dist/assets/index-Ck3fQ2ab.js',
    'web/dist/assets/index-B9dL0xyz.css',
  ]);

  it('accepts a tarball with the built shell and at least one asset', () => {
    expect(findPackGaps(goodPack, RUNNERS)).toEqual([]);
  });

  it('rejects a tarball without web/dist/index.html', () => {
    const gaps = findPackGaps(goodPack.filter((f) => f !== 'web/dist/index.html'), RUNNERS);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/index.html');
  });

  it('rejects a tarball whose shell has no hashed bundles', () => {
    const gaps = findPackGaps(withEntries(['dist/index.js', 'web/dist/index.html']), RUNNERS);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/assets');
  });

  it('does not count a bare "web/dist/assets/" prefix as a bundle', () => {
    const gaps = findPackGaps(withEntries(['web/dist/index.html', 'web/dist/assets/']), RUNNERS);
    expect(gaps).toHaveLength(1);
  });

  it('reports both gaps for the pre-redesign file list (the R1 bug)', () => {
    // What `files` shipped before the packaging flip: sources, no Vite build.
    const legacy = ['README.md', 'dist/index.js', 'web/index.html', 'web/app.js', 'web/style.css'];
    expect(findPackGaps(withEntries(legacy), RUNNERS)).toHaveLength(2);
  });

  it('does not accept nested lookalikes for the shell (exact path match)', () => {
    const gaps = findPackGaps(withEntries(['web/dist/nested/index.html', 'web/dist/assets/a.js']), RUNNERS);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/index.html');
  });

  it('names each missing plugin entry and bundled runner entry', () => {
    const files = withEntries(['web/dist/index.html', 'web/dist/assets/a.js'])
      .filter(f => f !== 'dist/plugin/pi-rpc.js' && f !== 'dist/runners/beta/index.js');
    expect(findPackGaps(files, RUNNERS)).toEqual([
      expect.stringContaining('dist/plugin/pi-rpc.js is missing'),
      expect.stringContaining('dist/runners/beta/index.js is missing — boot would not load the beta runner'),
    ]);
  });

  it('refuses a tarball checked against no bundled runner', () => {
    expect(findPackGaps(withEntries(['web/dist/index.html', 'web/dist/assets/a.js']), [])).toEqual([expect.stringContaining('no bundled runner')]);
  });

  it('checks every plugin subpath that package.json exports and the resolve hook maps', () => {
    const exported = Object.entries(packageJson.exports).filter(([subpath]) => subpath.startsWith('./plugin')).map(([, file]) => file.replace(/^\.\//, ''));
    expect([...PLUGIN_ENTRY_FILES].sort()).toEqual(exported.sort());
    expect(PLUGIN_ENTRY_FILES).toHaveLength(Object.keys(PLUGIN_ENTRY_SUBPATHS).length);
  });
});
