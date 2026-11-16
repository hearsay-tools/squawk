// A full, unsharded inventory prevents an empty PR selection from becoming a pass.
import { execFileSync } from 'node:child_process';
import { relative, isAbsolute } from 'node:path';

const firstLine = error => String(error?.stderr || error?.message || error).split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? 'unknown error';

// The import-graph tests of the changed source plus the declared readers, or
// the reason the selection cannot stand and the full suite runs.
export function unitFiles(selection, run = execFileSync) {
  if (selection.mode !== 'changed') return { reason: selection.reason };
  let graph = [];
  if (selection.sources.length) {
    try {
      const rows = JSON.parse(run('npm', ['exec', '--no', '--', 'vitest', 'list', '--filesOnly', '--json',
        '--project', 'server', '--project', 'contract', '--project', 'api-client', '--project', 'web',
        `--changed=${selection.base}`], { cwd: selection.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
      graph = rows.map(row => relative(selection.cwd, row.file));
    } catch (error) {
      return { reason: `Vitest inventory failed: ${firstLine(error)}` };
    }
    const outside = graph.find(file => isAbsolute(file) || file.startsWith('..') || !file.startsWith('packages/'));
    if (outside !== undefined) return { reason: `Vitest inventory listed a file outside packages/: ${outside}` };
  }
  const files = [...new Set([...graph, ...selection.tests])];
  return files.length ? { files } : { reason: 'Vitest selection matched no test file' };
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
    return { skip: `the selector failed: ${error.message}` };
  }
  if (chosen.all || chosen.specs.length >= total) return { chosen, skip: 'the selector chose every spec' };
  if (chosen.specs.length === 0) return { chosen, skip: 'the selector chose no spec' };
  return { chosen };
}
