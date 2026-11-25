import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerMock } from './runner-definition.ts';

const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts', import.meta.url));

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `RunnerMock.script` against the running copy's `scripts/` folder.
 * Throws an error naming the script when the running installation does not ship it.
 */
export function nativeMockPath(mock: Pick<RunnerMock, 'script'>): string {
  const { script } = mock;
  const validName = script.length > 0 && script !== '.' && script !== '..' && !script.includes('/') && !script.includes('\\') && basename(script) === script;
  const resolved = validName ? join(SCRIPTS_DIR, script) : undefined;
  if (!resolved || !isFile(resolved)) {
    throw new Error(`Native mock script "${script}" is not shipped by this Squawk installation.`);
  }
  return resolved;
}
