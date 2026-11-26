import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bundledFeatureFolders, bundledFeaturesDir } from './bundled-features.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsq-features-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it('resolves the shipped folder beside the plugin folder', () => {
  expect(bundledFeaturesDir()).toBe(join(import.meta.dirname, '..', 'features/'));
});

it('accepts absent and empty folders', () => {
  expect(bundledFeatureFolders(dir)).toEqual([]);
  expect(bundledFeatureFolders(join(dir, 'absent'))).toEqual([]);
});

it('propagates read failures other than absence', () => {
  const file = join(dir, 'file');
  writeFileSync(file, '');
  expect(() => bundledFeatureFolders(file)).toThrow();
});

it('ignores folders without entries and sorts entries in code-point order', () => {
  for (const id of ['b', 'B', '_z', 'a', 'Ä', 'empty']) {
    mkdirSync(join(dir, id));
    if (id !== 'empty') writeFileSync(join(dir, id, 'index.ts'), '');
  }
  writeFileSync(join(dir, 'notes'), '');
  expect(bundledFeatureFolders(dir).map(folder => folder.id)).toEqual(['B', '_z', 'a', 'b', 'Ä']);
});

it('prefers mjs, then js, then ts', () => {
  mkdirSync(join(dir, 'one'));
  for (const file of ['index.ts', 'index.js', 'index.mjs']) {
    writeFileSync(join(dir, 'one', file), '');
    expect(bundledFeatureFolders(dir)).toEqual([{ id: 'one', path: join(dir, 'one'), entry: join(dir, 'one', file) }]);
  }
});
