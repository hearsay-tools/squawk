import { excludeFromGit } from './worktree-paths.ts';
import { withWorktreeFiles, type WorktreeFilesOptions } from './worktree-manifest.ts';

/** First line of the ignore files older Squawk versions installed in skills folders. */
export const PROVISION_IGNORE_MARK = '# cezar: skills installed for this task, not part of the repository';

/** Remove only recorded, unchanged skill entries. Save records last so an interrupted pass can repeat. */
export function removeProvisionedSkills(worktree: string, options: WorktreeFilesOptions = {}): Promise<void> {
  return withWorktreeFiles(worktree, 'skills', options, undefined, async (files) => {
    // No records means no writes, including to an unreadable or absent manifest.
    if (files.entries().length === 0 && files.roots.length === 0) return;
    try {
      // Old installers recorded ignore files first. Keep exclusions until every skill is handled.
      const entries = files.entries().sort((a, b) => Number(a.kind === 'ignore-file') - Number(b.kind === 'ignore-file'));
      for (const entry of entries) {
        // An unverifiable old copy stays, including its exclusion after the ignore file goes.
        if ((await files.inspect(entry.path)).owner === 'kept') await excludeFromGit(files.worktree, `${entry.path}/`);
        else if (await files.remove(entry.path)) continue;
        files.forget(entry.path);
      }
      files.roots = [];
      await files.save();
    } catch {
      // Leave durable records for the next step open or Continue to retry.
    }
  });
}
