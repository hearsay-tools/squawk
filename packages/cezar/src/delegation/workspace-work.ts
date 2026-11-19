/** Work an explicit worker destroy would delete (hearsay-tools/squawk#3553): uncommitted changes in
 * the worker directory, and commits on the worker branch, or only in its reflog, that no other
 * branch or remote-tracking ref reaches. The same N/C/U split the family-end rule keeps
 * (`.ai/specs/2026-07-18-worktree-retention.md` § Family end). */
import type { WorkerDestroyWork, OwnedWorkerWorkspace } from '@open-mercato/cezar-contract';
import { entryExists } from './entry-exists.ts';
import { branchLog, workspaceGit } from './workspace-git.ts';

/** A Git call in the repository root that reports failure instead of throwing. */
export type RepoGit = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

/** The branch state the work checks read: its tip and its reflog. */
export interface BranchState { sha: string; log: { content: Buffer } }

/** For the branch tip and each reflog entry that is not the baseline, a branch or remote-tracking
 * ref that contains it, other than this branch and never an alias; undefined when one has none,
 * or when one ref is seen at two tips. A tip's ref also keeps every commit under it. */
export async function keepingRefs(git: RepoGit, workspace: OwnedWorkerWorkspace, branch: BranchState): Promise<Array<{ ref: string; sha: string }> | undefined> {
  const tip = branch.sha;
  const refs = new Map<string, string>();
  for (const sha of new Set([tip, ...reflogTips(branch)])) {
    if (sha === workspace.baselineSha) continue;
    if (sha !== tip && refs.size > 0 && (await git(['merge-base', '--is-ancestor', sha, tip])).ok) continue;
    const listed = await git(['for-each-ref', '--contains', sha, '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads', 'refs/remotes']);
    const witness = listed.ok ? listed.stdout.split('\n').map(line => line.split('\0'))
      .find(([ref, at, symref]) => ref && at && !symref && ref !== `refs/heads/${workspace.branch}`) : undefined;
    if (!witness || (refs.has(witness[0]!) && refs.get(witness[0]!) !== witness[1])) return undefined;
    refs.set(witness[0]!, witness[1]!);
  }
  return [...refs].map(([ref, sha]) => ({ ref, sha }));
}

function reflogTips(branch: BranchState): string[] {
  return branch.log.content.toString('utf8').split('\n').filter(Boolean).map(entry => entry.split(' ')[1] ?? '').filter(Boolean);
}

/** Commits the branch tip or its reflog holds that no other branch or remote-tracking ref
 * reaches: 0 when `keepingRefs` finds a keeper for each, otherwise at least 1. */
export async function unlandedCommits(git: RepoGit, workspace: OwnedWorkerWorkspace, branch: BranchState): Promise<number> {
  if (await keepingRefs(git, workspace, branch)) return 0;
  const tips = [...new Set([branch.sha, ...reflogTips(branch)])].filter(sha => sha !== workspace.baselineSha);
  const counted = await git(['rev-list', '--count', ...tips, `^${workspace.baselineSha}`, '--not', `--exclude=${workspace.branch}`, '--branches', '--remotes']);
  const commits = counted.ok ? Number(counted.stdout.trim()) : NaN;
  // Unreachable reflog entries or an alias can leave nothing countable; the work is still unproven.
  return Number.isInteger(commits) && commits > 0 ? commits : 1;
}

/** Files with uncommitted changes in a worker directory: staged, modified, deleted or untracked;
 * ignored files do not count. Throws when Git cannot read the directory. */
export async function uncommittedFiles(path: string): Promise<number> {
  const status = await workspaceGit(path, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) throw new Error('Owned workspace Git status failed');
  const fields = status.stdout.split('\0');
  let files = 0;
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    files++;
    // A rename or copy carries its source path as the next field.
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return files;
}

/** The work a destroy would delete now, or undefined when there is none. Reads only; the checked
 * removal repeats it under the worktree mutation lock. Throws when Git cannot answer. */
export async function workspaceWork(repoRoot: string, workspace: OwnedWorkerWorkspace): Promise<WorkerDestroyWork | undefined> {
  const files = await entryExists(workspace.path) ? await uncommittedFiles(workspace.path) : 0;
  const tip = await workspaceGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${workspace.branch}^{commit}`]);
  const sha = tip.ok ? tip.stdout.trim() : '';
  const commits = sha ? await unlandedCommits(args => workspaceGit(repoRoot, args), workspace, { sha, log: await branchLog(repoRoot, workspace) }) : 0;
  return files || commits ? { uncommittedFiles: files, commits } : undefined;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The refusal that names the work and both ways forward. */
export function describeWork(workerId: string, work: WorkerDestroyWork): string {
  const parts = [
    ...(work.uncommittedFiles ? [count(work.uncommittedFiles, 'uncommitted file', 'uncommitted files')] : []),
    ...(work.commits ? [`${count(work.commits, 'commit', 'commits')} no other branch reaches`] : []),
  ];
  return `Worker ${workerId.slice(0, 8)} holds work destroy would delete: ${parts.join(' and ')}. ` +
    'Land or commit what you need and rerun destroy, or rerun destroy with --discard-work to delete it';
}
