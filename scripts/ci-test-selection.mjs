// A full, unsharded inventory prevents an empty PR selection from becoming a pass.
import { execFileSync } from 'node:child_process';
import { relative, isAbsolute } from 'node:path';

export function unitFiles(selection, run = execFileSync) {
  if (selection.mode !== 'changed') return null;
  try {
    const rows = JSON.parse(run('npm', ['exec', '--no', '--', 'vitest', 'list', '--filesOnly', '--json',
      '--project', 'server', '--project', 'contract', '--project', 'api-client', '--project', 'web',
      `--changed=${selection.base}`], { cwd: selection.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
    const files = rows.map(row => relative(selection.cwd, row.file));
    if (!files.length || files.some(file => isAbsolute(file) || file.startsWith('..') || !file.startsWith('packages/'))) return null;
    return [...new Set(files)];
  } catch {
    return null;
  }
}

/**
 * The browser selection PR CI receives: `files` is null for every spec or a failed selector, and
 * empty when no spec reaches the change. `reason`, the per-file `lines` and the `drift` lines come with it.
 */
export function browserFiles(select) {
  try {
    const chosen = select();
    return { files: chosen.all ? null : chosen.specs, reason: chosen.reason, lines: chosen.lines, drift: chosen.drift };
  } catch (error) {
    return { files: null, reason: `the selector failed: ${String(error?.message ?? error).split('\n')[0]}` };
  }
}
