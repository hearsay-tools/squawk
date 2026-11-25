#!/usr/bin/env node
/**
 * Copy every non-test `.mjs` asset under `src/runners/<id>/` to the same relative path under
 * `dist/runners/<id>/` (spec 2026-11-25-self-contained-runner-folders, Decision 3). `tsc` copies
 * no `.mjs` files; `postbuild` runs this script after `inline-contract.mjs`, and `check:pack`
 * verifies every copied asset is present in the tarball.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_FILES = ['index.mjs', 'index.js', 'index.ts'];
const SKIP_DIRS = new Set(['__fixtures__', '__tests__', 'fixtures', 'node_modules']);
const TEST_MJS = /\.(?:test|testkit|spec)\.mjs$/;

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function discoverBundledRunnerIds(srcRunnersDir) {
  return readdirSync(srcRunnersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ENTRY_FILES.some((file) => isFile(join(srcRunnersDir, entry.name, file))))
    .map((entry) => entry.name)
    .sort();
}

/**
 * List POSIX paths relative to `srcRunnersDir` (e.g. `pi/extensions/pi-ci-wait.mjs`) for every
 * non-test `.mjs` asset under the bundled runner folders.
 */
export function listRunnerAssets(srcRunnersDir, runnerIds) {
  const ids = runnerIds ?? discoverBundledRunnerIds(srcRunnersDir);
  const assets = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.mjs') && !TEST_MJS.test(entry.name)) {
        assets.push(relative(srcRunnersDir, fullPath).replaceAll('\\', '/'));
      }
    }
  };
  for (const id of ids) walk(join(srcRunnersDir, id));
  return assets.sort();
}

/** Copy every listed runner `.mjs` asset from `srcRunnersDir` into `distRunnersDir`. */
export function copyRunnerAssets(srcRunnersDir, distRunnersDir, runnerIds) {
  const assets = listRunnerAssets(srcRunnersDir, runnerIds);
  for (const rel of assets) {
    const dest = join(distRunnersDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(srcRunnersDir, rel), dest);
  }
  return assets;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const srcRunnersDir = process.argv[2] ? resolve(process.argv[2]) : join(pkgRoot, 'src', 'runners');
  const distRunnersDir = process.argv[3] ? resolve(process.argv[3]) : join(pkgRoot, 'dist', 'runners');
  const copied = copyRunnerAssets(srcRunnersDir, distRunnersDir);
  console.log(`copy-runner-assets ok — copied ${copied.length} runner asset(s)`);
}
