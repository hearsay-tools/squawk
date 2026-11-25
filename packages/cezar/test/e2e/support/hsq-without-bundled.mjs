#!/usr/bin/env node
// Test and live-run wrapper (spec 2026-11-25-self-contained-runner-folders, decision 5).
// Boots the built Squawk product with an empty bundled-runners folder and the host
// `<config>/plugins/` folder, then runs `dist/hsq.js` in the same process so the CLI's
// own `bootRuntime` call reuses this boot.
//
// Usage:
//   node packages/cezar/test/e2e/support/hsq-without-bundled.mjs [--package-root <dir>] [--] <hsq args...>
//
// `--package-root <dir>` points to an installed package root (for example the unpacked
// tarball's `node_modules/@wjarka/cezarion`). When omitted, it defaults to this checkout's
// `packages/cezar/` (using its built `dist/`). Set `HSQ_HOME` to a sandbox home whose
// `config/plugins/` holds the copied runner folders.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rawArgs = process.argv.slice(2);
let argIndex = 0;
if (rawArgs[argIndex] === '--package-root') {
  if (argIndex + 1 >= rawArgs.length) {
    console.error('Missing value for --package-root');
    process.exit(2);
  }
  packageRoot = resolve(rawArgs[argIndex + 1]);
  argIndex += 2;
} else if (rawArgs[argIndex]?.startsWith('--package-root=')) {
  packageRoot = resolve(rawArgs[argIndex].slice('--package-root='.length));
  argIndex += 1;
}
if (rawArgs[argIndex] === '--') argIndex += 1;
const cliArgs = rawArgs.slice(argIndex);

// Canonicalize so `dist/boot.js` and `dist/hsq.js` resolve to the same ESM module cache entry.
const distDir = join(realpathSync(packageRoot), 'dist');
const emptyBundled = mkdtempSync(join(tmpdir(), 'hsq-no-bundled-'));
try {
  const { bootRuntime, hostPluginsDir } = await import(pathToFileURL(join(distDir, 'boot.js')).href);
  const { resolveHome } = await import(pathToFileURL(join(distDir, 'home/resolve.js')).href);
  const pluginsDir = hostPluginsDir(() => resolveHome({ purpose: 'cli' }));
  await bootRuntime({ bundledRunnersDir: emptyBundled, pluginsDir });
} finally {
  rmSync(emptyBundled, { recursive: true, force: true });
}

const cliEntry = join(distDir, 'hsq.js');
process.argv = [process.argv[0], cliEntry, ...cliArgs];
await import(pathToFileURL(cliEntry).href);
