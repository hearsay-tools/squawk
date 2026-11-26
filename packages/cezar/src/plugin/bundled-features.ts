import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Entry lookup order for built bundles and source checkouts. */
export const BUNDLED_FEATURE_ENTRY_FILES = ['index.mjs', 'index.js', 'index.ts'] as const;

export interface BundledFeatureFolder {
  readonly id: string;
  readonly path: string;
  readonly entry: string;
}

/** The features folder shipped beside this module's folder. */
export function bundledFeaturesDir(): string {
  return fileURLToPath(new URL('../features/', import.meta.url));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Discover directory entries in locale-independent folder-name order. Missing bundles are valid. */
export function bundledFeatureFolders(dir: string = bundledFeaturesDir()): BundledFeatureFolder[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(folder => folder.isDirectory()).flatMap(folder => {
    const path = join(dir, folder.name);
    const entry = BUNDLED_FEATURE_ENTRY_FILES.map(file => join(path, file)).find(isFile);
    return entry ? [{ id: folder.name, path, entry }] : [];
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
