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
 * PR CI runs browser specs only for a selection shorter than the full set. Every other
 * answer returns `skip`, the reason PR CI runs no spec; the merge queue runs every spec.
 */
export function browserFiles(select, total) {
  let chosen;
  try {
    chosen = select();
  } catch (error) {
    return { skip: `the selector failed: ${String(error?.message ?? error).split('\n')[0]}` };
  }
  const why = chosen.reason ? `: ${chosen.reason}` : '';
  if (chosen.all || chosen.specs.length >= total) return { chosen, skip: `the selector chose every spec${why}` };
  if (chosen.specs.length === 0) return { chosen, skip: `the selector chose no spec${why}` };
  return { chosen };
}
