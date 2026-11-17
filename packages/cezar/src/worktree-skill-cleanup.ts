import { realpath } from 'node:fs/promises';
import { excludeFromGit } from './worktree-paths.ts';
import { withWorktreeFiles, type WorktreeFilesOptions } from './worktree-manifest.ts';

/** First line of the ignore files older Squawk versions installed in skills folders. */
export const PROVISION_IGNORE_MARK = '# cezar: skills installed for this task, not part of the repository';

interface SkillCleanupOptions extends WorktreeFilesOptions {
  onError?: (error: unknown) => void;
}

/** Cleanup belongs only to the run's recorded task worktree, never an alias of the main checkout. */
export async function cleanupTaskWorktreeSkills(
  cwd: string,
  worktreePath: string | undefined,
  repoRoot: string,
  note: (message: string) => void,
): Promise<void> {
  if (!worktreePath) return;
  const [current, recorded, repo] = await Promise.all([cwd, worktreePath, repoRoot].map(path => realpath(path).catch(() => null)));
  if (current === null || recorded === null || repo === null || current !== recorded || current === repo) return;
  await removeProvisionedSkills(cwd, { onError: error => {
    note(`Could not clean old skills in ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
  } });
}

/** Remove only recorded, unchanged skill entries. Save records last so an interrupted pass can repeat. */
export function removeProvisionedSkills(worktree: string, options: SkillCleanupOptions = {}): Promise<void> {
  return withWorktreeFiles(worktree, 'skills', options, undefined, async (files) => {
    // No records means no writes, including to an unreadable or absent manifest.
    if (files.entries().length === 0 && files.roots.length === 0) return;
    // Old installers recorded ignore files first. Keep exclusions until every skill is handled.
    const entries = files.entries().sort((a, b) => Number(a.kind === 'ignore-file') - Number(b.kind === 'ignore-file'));
    for (const entry of entries) {
      // Changed and unverifiable copies stay excluded after their ignore file goes.
      const owner = (await files.inspect(entry.path)).owner;
      if (entry.kind !== 'ignore-file' && (owner === 'kept' || owner === 'theirs')) {
        if (!(await excludeFromGit(files.worktree, `${entry.path}/`))) throw new Error(`Could not exclude ${entry.path} from git`);
      }
      else if (await files.remove(entry.path)) continue;
      files.forget(entry.path);
    }
    files.roots = [];
    await files.save();
  }).catch(error => {
    // Leave durable records for the next step open or Continue to retry; the runner can still start.
    options.onError?.(error);
  });
}
