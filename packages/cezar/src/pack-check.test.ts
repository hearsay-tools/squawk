import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findPackGaps, PLUGIN_ENTRY_FILES } from './pack-check.ts';
import { PLUGIN_ENTRY_SUBPATHS } from './plugin/resolve-hook.ts';
import { copyRunnerAssets, listRunnerAssets } from '../scripts/copy-runner-assets.mjs';

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

  it('accepts present runner .mjs assets and fails when one is missing from the tarball', () => {
    const assets = ['dist/runners/alpha/extensions/a.mjs', 'dist/runners/beta/b.mjs'];
    expect(findPackGaps([...goodPack, ...assets], RUNNERS, assets)).toEqual([]);
    const gaps = findPackGaps([...goodPack, assets[0]!], RUNNERS, assets);
    expect(gaps).toEqual([expect.stringContaining('dist/runners/beta/b.mjs is missing')]);
  });
});

describe('copy-runner-assets', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/copy-runner-assets.mjs', import.meta.url));

  it('copies non-test .mjs runner assets preserving paths and excludes fixtures, tests, and non-bundled folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'hsq-copy-runner-assets-'));
    try {
      const srcRunners = join(root, 'src/runners');
      const distRunners = join(root, 'dist/runners');
      mkdirSync(join(srcRunners, 'alpha/extensions'), { recursive: true });
      mkdirSync(join(srcRunners, 'alpha/__fixtures__'), { recursive: true });
      mkdirSync(join(srcRunners, 'beta'), { recursive: true });
      mkdirSync(join(srcRunners, 'fixture'), { recursive: true });

      writeFileSync(join(srcRunners, 'alpha/index.ts'), 'export const displayOrder = 1;\n');
      writeFileSync(join(srcRunners, 'alpha/extensions/tool.mjs'), 'export const tool = 1;\n');
      writeFileSync(join(srcRunners, 'alpha/extensions/tool.test.mjs'), 'export {};\n');
      writeFileSync(join(srcRunners, 'alpha/extensions/helper.testkit.mjs'), 'export {};\n');
      writeFileSync(join(srcRunners, 'alpha/__fixtures__/stub.mjs'), 'export {};\n');
      writeFileSync(join(srcRunners, 'beta/index.ts'), 'export const displayOrder = 2;\n');
      writeFileSync(join(srcRunners, 'beta/scope.mjs'), 'export const scope = 2;\n');
      writeFileSync(join(srcRunners, 'beta/scope.d.mts'), 'export const scope: number;\n');
      // Non-bundled test-only runner (no index.* entry) must be ignored.
      writeFileSync(join(srcRunners, 'fixture/ignored.mjs'), 'export {};\n');

      const expected = ['alpha/extensions/tool.mjs', 'beta/scope.mjs'];
      expect(listRunnerAssets(srcRunners)).toEqual(expected);

      const copied = copyRunnerAssets(srcRunners, distRunners);
      expect(copied).toEqual(expected);
      expect(readFileSync(join(distRunners, 'alpha/extensions/tool.mjs'), 'utf8')).toBe('export const tool = 1;\n');
      expect(readFileSync(join(distRunners, 'beta/scope.mjs'), 'utf8')).toBe('export const scope = 2;\n');
      expect(existsSync(join(distRunners, 'alpha/extensions/tool.test.mjs'))).toBe(false);
      expect(existsSync(join(distRunners, 'alpha/extensions/helper.testkit.mjs'))).toBe(false);
      expect(existsSync(join(distRunners, 'alpha/__fixtures__/stub.mjs'))).toBe(false);
      expect(existsSync(join(distRunners, 'beta/scope.d.mts'))).toBe(false);
      expect(existsSync(join(distRunners, 'fixture/ignored.mjs'))).toBe(false);

      // CLI entrypoint copies into the target dist directory and findPackGaps enforces every listed asset.
      const cliDist = join(root, 'cli-dist/runners');
      const output = execFileSync(process.execPath, [scriptPath, srcRunners, cliDist], { encoding: 'utf8' });
      expect(output).toContain('copied 2 runner asset(s)');
      expect(readFileSync(join(cliDist, 'alpha/extensions/tool.mjs'), 'utf8')).toBe('export const tool = 1;\n');

      const expectedPackAssets = expected.map((rel) => `dist/runners/${rel}`);
      const basePack = withEntries(['web/dist/index.html', 'web/dist/assets/a.js']);
      expect(findPackGaps([...basePack, ...expectedPackAssets], RUNNERS, expectedPackAssets)).toEqual([]);
      expect(findPackGaps([...basePack, expectedPackAssets[0]!], RUNNERS, expectedPackAssets)).toEqual([
        expect.stringContaining('dist/runners/beta/scope.mjs is missing'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
