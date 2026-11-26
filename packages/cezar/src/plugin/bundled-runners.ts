import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bundled runners: each child folder of `runners/` with a plugin entry file (spec
 * 2026-11-24-plugin-loader-and-runner-kit § 5). This module reads folders and entry text only. It
 * imports no runner code, so the global test setup, the lint plugin and plain-Node scripts can
 * read the bundled runner ids without loading a runner.
 *
 * A folder without an entry file (`runners/fixture/`, the test-only runner) is not a bundled
 * runner. Each entry declares `export const displayOrder = <integer>;` on one line; the runners
 * load and list in that order, lowest first.
 */

/** The entry files of a bundled runner folder, in lookup order: built `dist/` has `index.js`, the source checkout `index.ts`. */
export const BUNDLED_RUNNER_ENTRY_FILES = ['index.mjs', 'index.js', 'index.ts'] as const;

export interface BundledRunnerFolder {
  /** The folder name, which is the runner id. */
  readonly id: string;
  readonly path: string;
  readonly entry: string;
  readonly displayOrder: number;
}

// oxlint-disable-next-line cez/regex-module-syntax -- reads the one-line declaration the entry contract above fixes, fails closed, and production code has no parser
const DISPLAY_ORDER = /^export const displayOrder = (\d+);$/gm;

/** The `runners/` folder next to this module's folder, in the source checkout and in `dist/`. */
export function bundledRunnersDir(): string {
  return fileURLToPath(new URL('../runners/', import.meta.url));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function displayOrderOf(entry: string): number {
  const orders = [...readFileSync(entry, 'utf8').matchAll(DISPLAY_ORDER)].map(match => Number(match[1]));
  if (orders.length !== 1) throw new Error(`Bundled runner entry ${entry} must declare \`export const displayOrder = <integer>;\` on one line, once; it declares it ${orders.length} times.`);
  return orders[0]!;
}

/**
 * The bundled runner folders under `dir`, in display order. Throws when an entry declares no
 * display order or two entries declare the same one: either is a defect of the bundle itself.
 */
export function bundledRunnerFolders(dir: string = bundledRunnersDir()): BundledRunnerFolder[] {
  const folders = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap((folder) => {
    const path = join(dir, folder.name);
    const entry = BUNDLED_RUNNER_ENTRY_FILES.map(file => join(path, file)).find(isFile);
    return entry ? [{ id: folder.name, path, entry, displayOrder: displayOrderOf(entry) }] : [];
  });
  // Folder-name code-point order breaks a tie, so the order and the error below never depend on readdir.
  folders.sort((a, b) => a.displayOrder - b.displayOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const repeated = folders.find((folder, index) => index > 0 && folders[index - 1]!.displayOrder === folder.displayOrder);
  if (repeated) throw new Error(`Bundled runners ${folders.filter(folder => folder.displayOrder === repeated.displayOrder).map(folder => folder.id).join(' and ')} declare the same displayOrder ${repeated.displayOrder}.`);
  return folders;
}

/** The ids of the bundled runners, in display order. */
export function bundledRunnerIds(dir?: string): string[] {
  return bundledRunnerFolders(dir).map(folder => folder.id);
}
