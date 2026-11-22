import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataReadDirs } from '../project-paths.ts';
import type { ColdRunIndex } from './run-index.ts';
import type { RepoHandle } from './store.ts';

type Options = { handle?: RepoHandle | null | undefined; archivedWindow?: number; roots?: boolean };
const entries = new Map<string, { fingerprint: string; index: ColdRunIndex }>();
const MAX_ENTRIES = 64;

/** Include both source roots, file replacement, same-size rewrites and uncheckpointed commits.
 * A stat failure disables caching; it must never turn a transient read error into cached history. */
function fingerprint(dataDir: string): { all: string; content: string } | undefined {
  try {
    const roots = [resolve(dataDir), ...dataReadDirs(dataDir).map(dir => resolve(dir))];
    const stats = roots.map(dir => ({ dir, files: ['', 'runs.db', 'runs.db-wal', 'runs.db-shm', 'runs.json'].map(file => {
      const stat = statSync(join(dir, file), { bigint: true, throwIfNoEntry: false });
      return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String) : null;
    }) }));
    return { all: JSON.stringify(stats), content: JSON.stringify(stats.map(({ dir, files }) =>
      [dir, files[1], files[2], files[4]])) };
  } catch { return undefined; }
}

/** Keep detached values: callers may change arrays or nested summary fields after a read. */
export function cachedRunIndex(dataDir: string, options: Options, read: (failed: () => void) => ColdRunIndex): ColdRunIndex {
  const key = JSON.stringify([resolve(dataDir), options.archivedWindow, options.roots ?? false,
    options.handle ? [options.handle.owner, options.handle.name] : null]);
  const before = fingerprint(dataDir);
  const cached = entries.get(key);
  if (before !== undefined && cached?.fingerprint === before.all) {
    entries.delete(key);
    entries.set(key, cached);
    return structuredClone(cached.index);
  }
  entries.delete(key);
  let failed = false;
  const index = read(() => { failed = true; });
  const after = fingerprint(dataDir);
  // A read-only open itself touches SHM. Keep its post-read stamp, but reject any change
  // to persistent content during the read. Later SHM or directory changes still invalidate.
  if (!failed && before !== undefined && after !== undefined && before.content === after.content) {
    entries.set(key, { fingerprint: after.all, index: structuredClone(index) });
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  }
  return index;
}
