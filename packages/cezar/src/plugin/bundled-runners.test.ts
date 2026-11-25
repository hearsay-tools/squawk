import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUNNER_ID } from '../core/runner-ids.ts';
import { bundledRunnerFolders, bundledRunnerIds, bundledRunnersDir } from './bundled-runners.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsq-bundled-runners-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function folder(name: string, file?: string, text = ''): void {
  mkdirSync(join(dir, name));
  if (file) writeFileSync(join(dir, name, file), text);
}

describe('bundledRunnerFolders', () => {
  it('lists the folders with an entry, in display order, and skips folders without one and plain files', () => {
    folder('omega', 'index.ts', 'export const displayOrder = 30;\n');
    folder('alpha', 'index.js', 'const x = 1;\nexport const displayOrder = 20;\nexport default () => {};\n');
    folder('mid', 'index.mjs', 'export const displayOrder = 5;\n');
    folder('fixture', 'definition.testkit.ts', 'export const displayOrder = 1;\n');
    folder('empty');
    writeFileSync(join(dir, 'notes.ts'), 'export const displayOrder = 2;\n');
    expect(bundledRunnerFolders(dir)).toEqual([
      { id: 'mid', path: join(dir, 'mid'), entry: join(dir, 'mid', 'index.mjs'), displayOrder: 5 },
      { id: 'alpha', path: join(dir, 'alpha'), entry: join(dir, 'alpha', 'index.js'), displayOrder: 20 },
      { id: 'omega', path: join(dir, 'omega'), entry: join(dir, 'omega', 'index.ts'), displayOrder: 30 },
    ]);
    expect(bundledRunnerIds(dir)).toEqual(['mid', 'alpha', 'omega']);
  });

  it('prefers the built entry over the source entry', () => {
    folder('one', 'index.ts', 'export const displayOrder = 1;\n');
    writeFileSync(join(dir, 'one', 'index.js'), 'export const displayOrder = 1;\n');
    expect(bundledRunnerFolders(dir)[0]?.entry).toBe(join(dir, 'one', 'index.js'));
  });

  it.each([
    ['no display order', 'export default () => {};\n', /declares it 0 times/],
    ['a display order that is not one plain line', 'export const displayOrder = 1 + 1;\n', /declares it 0 times/],
    ['two display orders', 'export const displayOrder = 1;\nexport const displayOrder = 2;\n', /declares it 2 times/],
  ])('refuses an entry with %s', (_case, text, message) => {
    folder('one', 'index.ts', text);
    expect(() => bundledRunnerFolders(dir)).toThrow(message);
  });

  it('refuses two runners with the same display order', () => {
    folder('one', 'index.ts', 'export const displayOrder = 10;\n');
    folder('two', 'index.ts', 'export const displayOrder = 10;\n');
    expect(() => bundledRunnerFolders(dir)).toThrow('Bundled runners one and two declare the same displayOrder 10.');
  });
});

describe('the bundled runners of this checkout', () => {
  it('reads the runners folder beside this module and lists the default runner first', () => {
    expect(bundledRunnersDir()).toBe(join(import.meta.dirname, '..', 'runners/'));
    const folders = bundledRunnerFolders();
    expect(folders.length).toBeGreaterThan(1);
    expect(folders[0]?.id).toBe(DEFAULT_RUNNER_ID);
    expect(folders.every(({ id, entry }) => entry === join(bundledRunnersDir(), id, 'index.ts'))).toBe(true);
  });
});
