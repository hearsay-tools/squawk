import { join } from 'node:path';
import { runGit } from '../git-command.ts';
import { legacyItemOwner } from '../legacy-runs.ts';
import { keptAmong } from './live.ts';
import { currentLeftovers, LEGACY_PROJECT_DIR, legacyStateLeft, MIGRATED_PROJECT_DIR } from './plan.ts';

/**
 * The untracked and ignored files under `.ai/cezar/`; a nested Git worktree is one entry that ends
 * in `/`. Undefined when the listing may be incomplete: Git failed, or it warned (a directory it
 * cannot open is skipped with a warning and exit 0).
 */
async function untrackedListing(root: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await runGit(['ls-files', '-z', '--others', '--', LEGACY_PROJECT_DIR], { cwd: root, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
    return stderr.trim() ? undefined : stdout;
  } catch { return undefined; }
}

/**
 * Whether a moved project's `.ai/cezar/` holds anything a move would act on now: the cockpit's
 * check before it plans a moved project at a start. The plan reads every run row, receipt and
 * evidence file, so it runs only when this answers true. Three kinds of item never move and do not
 * count: the `cockpit.lock*` ownership claims, tracked files (the move prints their `git mv`), and
 * the items of the tasks the kept-task list names while each can still resume. An item of any
 * other kind, or of a task that has since been archived or deleted, counts. When Git, the kept-task
 * list or a run store cannot be read, or Git warns while it lists, the answer is true and the plan decides.
 */
export async function legacyMoveWorkLeft(root: string): Promise<boolean> {
  const source = join(root, ...LEGACY_PROJECT_DIR.split('/'));
  const destination = join(root, ...MIGRATED_PROJECT_DIR.split('/'));
  if (!legacyStateLeft(source, destination)) return false;
  // An unreadable kept-task list is work: the move rewrites it from the run store.
  const leftovers = currentLeftovers(destination);
  if (leftovers === undefined) return true;
  const recorded = new Set(leftovers);
  const listed = await untrackedListing(root);
  if (listed === undefined) return true;
  const owners = new Set<string>();
  for (const path of listed.split('\0').filter(Boolean)) {
    const parts = path.replace(/\/$/, '').split('/').slice(LEGACY_PROJECT_DIR.split('/').length);
    if (parts[0]?.startsWith('cockpit.lock')) continue;
    const owner = legacyItemOwner(parts, recorded);
    if (owner === undefined) return true;
    owners.add(owner);
  }
  if (owners.size === 0) return false;
  const kept = keptAmong(root, owners);
  return kept === undefined || [...owners].some(id => !kept.has(id));
}
