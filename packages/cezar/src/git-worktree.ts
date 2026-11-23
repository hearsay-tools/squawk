import { execFile } from 'node:child_process';
import { projectPaths, isFallbackProjectPath } from './project-paths.ts';
import { git } from './git-command.ts';
import { ownedWorkspaceSchema } from '@open-mercato/cezar-contract/delegation';
import { existsSync, realpathSync, type Dirent, type Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveTaskDiffBase } from './git-diff-base.ts';
import { withPrivateIndex, type IndexGit, type LiveIndexCheck, type DiffRefusal } from './git-private-index.ts';
import { isSafeGitRef } from './git-refs.ts';
import { withWorktreeMutation, type WorktreeGit, type WorktreeGitResult } from './git-worktree-lock.ts';

/** One worktree per task (spec 006). Only createWorktree throws; its caller reports failure. */

export const DIFF_CAP = 400_000;

interface RegisteredWorktree {
  path: string;
  branch?: string;
}

export function branchFor(runId: string): string {
  return `cez/${runId.slice(0, 8)}`;
}

/**
 * Resolve a worktree base without throwing. Prefer local only when it contains origin’s base;
 * otherwise prefer origin. Keep this rule aligned with freshestBaseRef.
 */
export async function resolveBaseRef(repoRoot: string, base: string): Promise<string | null> {
  if (!isSafeGitRef(base)) return null;
  const verify = (ref: string) =>
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((r) => r.ok);
  const [hasLocal, hasRemote] = await Promise.all([verify(base), verify(`origin/${base}`)]);
  if (hasLocal && hasRemote) {
    // `--is-ancestor origin/<base> <base>` succeeds iff local is equal-or-ahead.
    const localCurrent = await git(repoRoot, ['merge-base', '--is-ancestor', `origin/${base}`, base]);
    return localCurrent.ok ? base : `origin/${base}`;
  }
  if (hasLocal) return base;
  if (hasRemote) return `origin/${base}`;
  return null;
}

export function worktreePathFor(repoRoot: string, runId: string): string {
  return join(projectPaths(repoRoot).write, 'worktrees', runId);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Branch name the worktree was forked from (commit sha when HEAD was detached). */
  baseBranch: string;
}

/** Parse `git worktree list --porcelain` without assuming paths contain no spaces. */
async function registeredWorktrees(repoRoot: string): Promise<RegisteredWorktree[]> {
  const res = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (!line && current) {
      worktrees.push(current);
      current = undefined;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function worktreeInfo(path: string, branch: string, baseBranch: string): WorktreeInfo {
  return { path, branch, baseBranch };
}

/** Git canonicalizes symlinked path prefixes (macOS `/var` → `/private/var`). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Establish the task worktree idempotently. Reuse registered worktrees or surviving task
 * branches; never delete a non-empty unregistered path. New branches use --no-track.
 */
export async function createWorktree(
  repoRoot: string,
  runId: string,
  baseBranch: string,
  options: { freshOnly?: boolean; addTimeoutMs?: number } = {},
): Promise<WorktreeInfo> {
  // A worker's worktree waits longer when the queue is long: it is made in the background, so a
  // queue under load delays the worker instead of failing it (hearsay-tools/squawk#3817).
  return withWorktreeMutation(repoRoot, git => createWorktreeLocked(repoRoot, runId, baseBranch, options, git), options.freshOnly
    ? { perClaimMs: WORKER_SPAWN_WAIT_PER_CLAIM_MS, label: { operation: 'worker-spawn', owner: runId } }
    : { label: { operation: 'task-worktree-create', owner: runId } });
}

/** The extra lock wait a worker's worktree creation gets for each claim queued ahead of it. */
export const WORKER_SPAWN_WAIT_PER_CLAIM_MS = 60_000;

async function resolveWorktreeBase(
  repoRoot: string, baseBranch: string, git: WorktreeGit,
): Promise<string> {
  let base = baseBranch;
  if (!base || base === 'HEAD') {
    // Detached HEAD — pin the base to the current commit so the record and
    // later diffs stay meaningful.
    const head = await git(repoRoot, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
    base = head.stdout.trim();
  }
  // Dash-guard (#431): `base` is spliced in as a positional git operand; an
  // option-like value would be argument injection.
  if (!isSafeGitRef(base)) throw new Error(`refusing option-like base ref: ${base}`);
  return base;
}

async function createFreshOwnedWorktree(
  repoRoot: string, base: string, branch: string, absolutePath: string, branchRef: string, git: WorktreeGit, addTimeoutMs: number,
): Promise<WorktreeInfo> {
  // Owned workers cannot inherit the legacy adoption/prune behavior. Even a stale
  // registration or an empty directory is a collision, not proof of ownership.
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain', '-z'], 30_000);
  if (!listed.ok) throw new Error('cannot verify existing worktree registrations');
  const paths = listed.stdout.split('\0').filter((entry) => entry.startsWith('worktree '));
  if (paths.some((entry) => canonicalPath(entry.slice(9)) === canonicalPath(absolutePath))) {
    throw new Error('owned worktree registration already exists');
  }
  const pathExists = await lstat(absolutePath).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
  // A lookup that fails is not absence: the rollback below deletes only a branch proven new here.
  const refs = await git(repoRoot, ['for-each-ref', '--format=%(refname)', branchRef], 30_000);
  if (!refs.ok) throw new Error(`cannot verify that ${branchRef} is absent: ${refs.stderr.trim()}`);
  if (pathExists || refs.stdout.split('\n').includes(branchRef)) throw new Error('owned worktree path or branch already exists');
  await mkdir(dirname(absolutePath), { recursive: true });
  // One commit for the add and for its rollback's compare-and-swap, even if `base` moves meanwhile.
  const resolved = await git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], 30_000);
  if (!resolved.ok) throw new Error(`cannot resolve worktree base ${base}: ${resolved.stderr.trim()}`);
  const baseSha = resolved.stdout.trim();
  let failure = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Reserve the previously absent path exclusively; Git accepts our empty directory.
    await mkdir(absolutePath);
    // --quiet: without it, git's stderr is its checkout progress, not the reason it failed.
    const created = await git(repoRoot, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, absolutePath, baseSha], addTimeoutMs);
    if (created.ok) return worktreeInfo(absolutePath, branch, base);
    failure = worktreeAddFailure(created, addTimeoutMs);
    // A checkout that may still be writing is not rolled back or retried; destroy names what it leaves.
    if (created.childrenRunning) { failure += '; rollback skipped: its Git child processes may still be running'; break; }
    // Still under the lock, the path and branch this call proved absent are its own: remove them,
    // so a retry, or a destroy after the worker fails, finds nothing left behind.
    const kept = await rollBackFreshWorktree(repoRoot, absolutePath, branchRef, baseSha, git).catch((error: unknown) => String(error));
    if (kept) { failure += `; rollback stopped: ${kept}`; break; }
  }
  throw new Error(`git worktree add failed: ${failure}`);
}

/** The bound on one `git worktree add` of a worker's worktree; a large checkout on a loaded host takes a while. */
export const OWNED_WORKTREE_ADD_TIMEOUT_MS = 120_000;

function worktreeAddFailure(result: WorktreeGitResult, timeoutMs: number): string {
  const stderr = result.stderr.trim();
  if (result.timedOut) return `timed out after ${timeoutMs / 1000} s${stderr ? `: ${stderr.slice(-500)}` : ''}`;
  return stderr.slice(-2000) || 'git exited without an error message';
}

const firstLine = (result: WorktreeGitResult) => result.stderr.trim().split('\n')[0]?.slice(0, 300) || 'git failed';

/** Undo a failed fresh `worktree add`: its registration, its new branch and the reserved directory.
 * Undefined when nothing is left; otherwise why it stopped, leaving the rest for a destroy to report. */
async function rollBackFreshWorktree(repoRoot: string, absolutePath: string, branchRef: string, baseSha: string, git: WorktreeGit): Promise<string | undefined> {
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain', '-z'], 30_000);
  if (!listed.ok) return `cannot list worktrees: ${firstLine(listed)}`;
  const registered = listed.stdout.split('\0').some(entry => entry.startsWith('worktree ') && canonicalPath(entry.slice(9)) === canonicalPath(absolutePath));
  if (registered) {
    const removed = await git(repoRoot, ['worktree', 'remove', '--force', absolutePath], 30_000);
    if (!removed.ok) return `cannot remove the registered worktree: ${firstLine(removed)}`;
  } else {
    // Unregistered, the path holds only what this call reserved, unless something else wrote there:
    // remove it only while it is empty.
    try { await rmdir(absolutePath); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return `${absolutePath} is not empty`;
      if (code !== 'ENOENT') return `cannot remove ${absolutePath}: ${(error as Error).message}`;
    }
  }
  // A lookup that fails is not absence: only a listing that succeeded proves the branch is gone.
  const refs = await git(repoRoot, ['for-each-ref', '--format=%(refname)%00%(symref)%00%(objectname)', branchRef], 30_000);
  if (!refs.ok) return `cannot read ${branchRef}: ${firstLine(refs)}`;
  const entry = refs.stdout.split('\n').map(line => line.split('\0')).find(([ref]) => ref === branchRef);
  if (entry) {
    // Only the branch this add made: a plain ref at the base commit. --no-deref never follows a
    // symbolic ref to delete its target, and the expected value refuses a branch that moved.
    if (entry[1]) return `${branchRef} is a symbolic ref`;
    const deleted = await git(repoRoot, ['update-ref', '--no-deref', '-d', branchRef, baseSha], 30_000);
    if (!deleted.ok) return `cannot delete ${branchRef}: ${firstLine(deleted)}`;
  }
  return existsSync(absolutePath) ? `${absolutePath} still exists` : undefined;
}

function registeredWorktreeInfo(
  atPath: RegisteredWorktree, branchRef: string, branch: string, base: string,
): WorktreeInfo {
  if (atPath.branch !== branchRef) {
    throw new Error(
      `managed worktree path is registered to ${atPath.branch ?? 'a detached HEAD'}, expected ${branchRef}`,
    );
  }
  return worktreeInfo(atPath.path, branch, base);
}

async function repairExistingWorktreePath(
  repoRoot: string, absolutePath: string, canonicalTarget: string,
  branchRef: string, branch: string, base: string, git: WorktreeGit,
): Promise<{ info: WorktreeInfo } | { registered: RegisteredWorktree[] }> {
  await git(repoRoot, ['worktree', 'repair', absolutePath]);
  const registered = await registeredWorktrees(repoRoot);
  const atPath = registered.find((item) => canonicalPath(item.path) === canonicalTarget);
  if (atPath) {
    return { info: registeredWorktreeInfo(atPath, branchRef, branch, base) };
  }
  const entries = await readdir(absolutePath).catch(() => ['unreadable']);
  if (entries.length > 0) {
    throw new Error(`managed worktree path already exists and could not be repaired: ${absolutePath}`);
  }
  return { registered };
}

async function attachExistingTaskBranch(
  repoRoot: string, runId: string, absolutePath: string, registered: RegisteredWorktree[],
  branchRef: string, branch: string, base: string, git: WorktreeGit,
): Promise<WorktreeInfo> {
  // The task branch may still be checked out after its directory was moved.
  // Reuse only a path whose basename is the full run id; a same-prefix UUID
  // collision must fail rather than point two tasks at one worktree.
  const byBranch = registered.find((item) => item.branch === branchRef);
  if (byBranch) {
    if (basename(byBranch.path) !== runId) {
      throw new Error(`task branch ${branch} is already checked out at ${byBranch.path}`);
    }
    return worktreeInfo(byBranch.path, branch, base);
  }
  const attach = await git(repoRoot, ['worktree', 'add', absolutePath, branch]);
  if (!attach.ok) {
    throw new Error(`git worktree reattach failed: ${attach.stderr.trim() || attach.stdout.trim()}`);
  }
  return worktreeInfo(absolutePath, branch, base);
}

async function createWorktreeLocked(
  repoRoot: string, runId: string, baseBranch: string,
  options: { freshOnly?: boolean; addTimeoutMs?: number }, git: WorktreeGit,
): Promise<WorktreeInfo> {
  const base = await resolveWorktreeBase(repoRoot, baseBranch, git);
  const branch = branchFor(runId);
  const absolutePath = join(projectPaths(canonicalPath(repoRoot)).write, 'worktrees', runId);
  const branchRef = `refs/heads/${branch}`;

  if (options.freshOnly) {
    return createFreshOwnedWorktree(repoRoot, base, branch, absolutePath, branchRef, git, options.addTimeoutMs ?? OWNED_WORKTREE_ADD_TIMEOUT_MS);
  }

  const protection = await ownedCleanupProtection(repoRoot);
  if (protection.uncertain || protection.paths.has(absolutePath) || protection.branches.has(branch)) throw new Error('Owned worktree requires verified provisioning');
  // A missing directory can leave stale administrative metadata behind.
  // Prune first so the checks below describe the filesystem as it exists now.
  if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
  const canonicalTarget = canonicalPath(absolutePath);
  let registered = await registeredWorktrees(repoRoot);
  const atPath = registered.find((item) => canonicalPath(item.path) === canonicalTarget);
  if (atPath) {
    return registeredWorktreeInfo(atPath, branchRef, branch, base);
  }

  // If the directory survived but its administrative entry did not, let Git
  // repair it. This is non-destructive; an unrepairable non-empty directory is
  // preserved and reported instead of being recursively removed.
  if (existsSync(absolutePath)) {
    const repaired = await repairExistingWorktreePath(
      repoRoot, absolutePath, canonicalTarget, branchRef, branch, base, git,
    );
    if ('info' in repaired) return repaired.info;
    registered = repaired.registered;
  }

  const branchExists = await git(repoRoot, ['show-ref', '--verify', '--quiet', branchRef]);
  if (branchExists.ok) {
    return attachExistingTaskBranch(
      repoRoot, runId, absolutePath, registered, branchRef, branch, base, git,
    );
  }

  const create = await git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, absolutePath, base]);
  if (!create.ok) {
    throw new Error(`git worktree add failed: ${create.stderr.trim() || create.stdout.trim()}`);
  }
  return worktreeInfo(absolutePath, branch, base);
}

/**
 * Best-effort on-disk size of a worktree directory in bytes, via POSIX
 * `du -sk` (kibibytes → bytes). Returns `null` when `du` is unavailable —
 * including all of Windows, where `du` is not a command — or on any error.
 * Never throws and never blocks: worktree retention is count-based, so a null
 * size only blanks the panel's size column, it does not affect reclamation.
 */
export function worktreeSizeBytes(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', path], { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
      resolve(Number.isFinite(kib) ? kib * 1024 : null);
    });
  });
}

type OwnedCleanupSets = { paths: Set<string>; branches: Set<string> };

const ownedReceiptCache = new Map<string, { key: string; path: string; branch: string }>();
function ownedReceiptKey(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

async function collectOwnedReceipts(receipts: string, sets: OwnedCleanupSets): Promise<boolean> {
  const entries = await readdir(receipts).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  const present = new Set(entries.map(entry => join(receipts, entry)));
  for (const path of ownedReceiptCache.keys()) if (dirname(path) === receipts && !present.has(path)) ownedReceiptCache.delete(path);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(receipts, entry); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return true;
    const key = ownedReceiptKey(info);
    const cached = ownedReceiptCache.get(path);
    if (cached?.key === key) { sets.paths.add(cached.path); sets.branches.add(cached.branch); continue; }
    ownedReceiptCache.delete(path);
    const receipt: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!receipt || typeof receipt !== 'object' || !('workspace' in receipt)) return true;
    const parsed = ownedWorkspaceSchema.safeParse(receipt.workspace);
    if (!parsed.success) return true;
    const workspace = parsed.data;
    if (workspace.branch !== branchFor(workspace.ownerRunId) ||
        !['cezar', 'squawk'].some(name => workspace.path.endsWith(join('.ai', name, 'worktrees', workspace.ownerRunId))) ||
        entry.replace(/(?:\.cleanup)?\.json$/, '') !== workspace.resourceId) return true;
    if (key === ownedReceiptKey(await lstat(path))) {
      if (ownedReceiptCache.size >= 20_000) ownedReceiptCache.delete(ownedReceiptCache.keys().next().value!);
      ownedReceiptCache.set(path, { key, path: workspace.path, branch: workspace.branch });
    }
    sets.paths.add(workspace.path); sets.branches.add(workspace.branch);
  }
  return false;
}

/** A provisioning crash can leave the administrative marker before its receipt. */
async function collectOwnedAdminMarkers(root: string, sets: OwnedCleanupSets): Promise<void> {
  const admins = await readdir(join(root, 'worktrees')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  for (const admin of admins) {
    const dir = join(root, 'worktrees', admin);
    const marker = await lstat(join(dir, 'cezar-owned-resource')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined; throw error;
    });
    if (marker) {
      sets.paths.add(dirname((await readFile(join(dir, 'gitdir'), 'utf8')).trim()));
      const head = (await readFile(join(dir, 'HEAD'), 'utf8')).trim();
      if (head.startsWith('ref: refs/heads/')) sets.branches.add(head.slice('ref: refs/heads/'.length));
    }
  }
}

/** Ownership receipts survive a missing run index and a replaced directory.
 * Unreadable/malformed evidence disables generic deletion instead of granting it. */
export async function ownedCleanupProtection(repoRoot: string): Promise<{ paths: Set<string>; branches: Set<string>; uncertain: boolean }> {
  const paths = new Set<string>(); const branches = new Set<string>();
  try {
    const common = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common.ok) return { paths, branches, uncertain: true };
    const root = common.stdout.trim();
    const receipts = join(root, 'cezar-owned-workspaces');
    const directory = await lstat(receipts).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined; throw error;
    });
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) return { paths, branches, uncertain: true };
    if (await collectOwnedReceipts(receipts, { paths, branches })) return { paths, branches, uncertain: true };
    await collectOwnedAdminMarkers(root, { paths, branches });
    return { paths, branches, uncertain: false };
  } catch { return { paths, branches, uncertain: true }; }
}

/** Remove a task worktree and optionally its branch. Best effort — never throws.
 *  Owned worker paths are refused unless `reclaimOwnedDirectory` is set and no
 *  branch is passed (retention #575: directory only, receipts and branch kept). */
export type RemoveWorktreeOptions = {
  reclaimOwnedDirectory?: boolean;
  onlyClean?: boolean;
  /** Runs once every check that can decline the removal has passed, right before git removes
   *  the checkout (#781: the run's preview is released here). A declined removal never calls it. */
  beforeRemove?: () => Promise<void>;
  /** Fresh generation/resource authorization, after all awaits and before destructive Git. */
  assertCurrent?: () => void;
};

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch?: string,
  opts?: RemoveWorktreeOptions,
): Promise<void> {
  await withWorktreeMutation(repoRoot, git => removeWorktreeLocked(repoRoot, worktreePath, branch, opts, git), { label: { operation: 'task-worktree-remove', owner: basename(worktreePath) } }).catch(() => undefined);
}

type OwnedCleanupProtection = { paths: Set<string>; branches: Set<string>; uncertain: boolean };

async function runBeforeWorktreeRemove(opts: RemoveWorktreeOptions | undefined): Promise<void> {
  await opts?.beforeRemove?.().catch(() => undefined);
  opts?.assertCurrent?.();
}

async function removeCleanWorktree(
  repoRoot: string, worktreePath: string, protection: OwnedCleanupProtection,
  git: WorktreeGit, beforeRemove: () => Promise<void>,
): Promise<void> {
  const head = await git(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const sha = head.stdout.trim();
  if (!head.ok || !sha) return;
  const kept = await git(repoRoot, ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  if (!kept.ok || kept.stdout.trim() === '') return;
  // The refusal git would give a dirty tree, read first so a declined removal costs nothing
  // (`beforeRemove` stops the run's preview). git still has the last word at removal time.
  // A user's `status.showUntrackedFiles=no` would hide untracked files from both reads, and git's
  // unforced removal would then delete them: both pin git's default.
  const status = await git(worktreePath, ['status', '--porcelain', '--untracked-files=normal']);
  if (!status.ok || status.stdout.trim() !== '') return;
  await beforeRemove();
  const removed = await git(repoRoot, ['-c', 'status.showUntrackedFiles=normal', 'worktree', 'remove', worktreePath]);
  if (!removed.ok) return;
  if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
}

async function forceRemoveWorktree(
  repoRoot: string, worktreePath: string, branch: string | undefined,
  reclaimOwnedDirectory: boolean, protection: OwnedCleanupProtection,
  git: WorktreeGit, beforeRemove: () => Promise<void>,
): Promise<void> {
  await beforeRemove();
  await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  // Owned-path reclaim must not `rm` a receipt path that is no longer a git
  // worktree — the directory may have been replaced with unrelated files.
  // For owned resources Git already removed the exact checkout. Never recursively delete a
  // path recreated after that operation (possibly by another execution/controller).
  if (reclaimOwnedDirectory && protection.paths.has(worktreePath)) return;
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
  if (branch) await git(repoRoot, ['branch', '-D', branch]);
}

async function removeWorktreeLocked(
  repoRoot: string, worktreePath: string, branch: string | undefined,
  opts: RemoveWorktreeOptions | undefined, git: WorktreeGit,
): Promise<void> {
  if (isFallbackProjectPath(repoRoot, worktreePath)) return;
  const beforeRemove = async () => runBeforeWorktreeRemove(opts);
  const protection = await ownedCleanupProtection(repoRoot);
  // Directory-only retention (#575) may reclaim a finished owned-worker checkout
  // while keeping its branch and receipts. Unowned deletion still refuses owned
  // paths, and a branch argument never deletes an owned ref.
  const reclaimOwnedDirectory = opts?.reclaimOwnedDirectory === true && branch === undefined;
  if (protection.uncertain) return;
  if (protection.paths.has(worktreePath) && !reclaimOwnedDirectory) return;
  if (branch !== undefined && protection.branches.has(branch)) return;
  if (reclaimOwnedDirectory && protection.paths.has(worktreePath)) {
    const listed = await git(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
    if (!listed.ok) return;
    const registered = listed.stdout.split(' ').some(
      (entry) => entry.startsWith('worktree ') && canonicalPath(entry.slice(9)) === canonicalPath(worktreePath),
    );
    if (!registered) return;
  }
  // Reclaim keeps the branch and calls the work recoverable, which holds only for what a REF keeps:
  // staged, unstaged and untracked files, and commits made on a detached HEAD, exist in this
  // checkout alone. So the HEAD must be reachable from a branch or remote-tracking ref, and the
  // removal is git's own unforced one — git refuses a dirty tree at the moment it removes, which a
  // status read beforehand cannot promise against an editor saving in between. Any refusal keeps
  // the directory: no forced fallback, no `rm`. Ignored files (build output) never block it.
  if (opts?.onlyClean) return removeCleanWorktree(repoRoot, worktreePath, protection, git, beforeRemove);
  return forceRemoveWorktree(repoRoot, worktreePath, branch, reclaimOwnedDirectory, protection, git, beforeRemove);
}

async function prepareWholeBranchDiff(git: IndexGit, baseBranch: string): Promise<string> {
  await git(['add', '-N', '.']); // intent-to-add (private index, hearsay-tools/cezarion#1080): untracked files show up
  const mergeBase = await git(['merge-base', baseBranch, 'HEAD']);
  return mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
}

/**
 * Whole-branch committed, uncommitted and untracked diff against the merge-base. Preserve this
 * anchor for the protected text endpoint and conservative settlement checks.
 * Callers without a live-index check, including settlement, keep a string result.
 */
export function worktreeDiff(worktreePath: string, baseBranch: string, cap?: number): Promise<string>;
export function worktreeDiff(worktreePath: string, baseBranch: string, cap: number | undefined, beforeLiveIndex: LiveIndexCheck): Promise<string | DiffRefusal>;
export async function worktreeDiff(
  worktreePath: string,
  baseBranch: string,
  cap = DIFF_CAP,
  beforeLiveIndex?: LiveIndexCheck,
): Promise<string | DiffRefusal> {
  if (!isSafeGitRef(baseBranch)) return '(diff failed: refusing option-like base ref)';
  return withPrivateIndex(worktreePath, async (git) => {
    const base = await prepareWholeBranchDiff(git, baseBranch);
    const res = await git(['diff', base]);
    if (!res.ok) return `(diff failed: ${res.stderr.trim() || 'unknown git error'})`;
    if (res.stdout.length > cap) return `${res.stdout.slice(0, cap)}\n… (diff truncated)`;
    return res.stdout;
  }, (): DiffRefusal | undefined => {
    const error = beforeLiveIndex?.();
    return error === undefined ? undefined : { error };
  });
}

/**
 * Whole-branch diff --stat for variant comparisons. Includes committed work; returns an empty
 * string on failure.
 */
export async function worktreeDiffStat(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  if (!isSafeGitRef(baseBranch)) return '';
  return withPrivateIndex(worktreePath, async (git) => {
    const base = await prepareWholeBranchDiff(git, baseBranch);
    const res = await git(['diff', '--stat', base]);
    return res.ok ? res.stdout.trim() : '';
  });
}

/** Aggregate diff numbers (#389) — the shape stored on `RunRecord.diffStat`. */
export interface DiffStat {
  adds: number;
  dels: number;
  files: number;
  /** Set only when the numbers were narrowed to what this run did on a branch it checked
   *  out into its worktree, because HEAD had been repointed off the task's branch (#751).
   *  Absent — never `false` — on a normal run, so the persisted shape is unchanged for
   *  every task that behaved. */
  repointed?: boolean;
}

/**
 * Parse `git diff --shortstat` output — " 3 files changed, 10 insertions(+),
 * 2 deletions(-)". Every part is optional: insertions-only and deletions-only
 * diffs omit the other counter, and an empty diff prints nothing at all
 * (→ all zeros). The wording is stable porcelain English — git does not
 * localize `--shortstat` — so matching the words is safe.
 */
export function parseShortstat(s: string): DiffStat {
  const files = /(\d+) files? changed/.exec(s);
  const adds = /(\d+) insertions?\(\+\)/.exec(s);
  const dels = /(\d+) deletions?\(-\)/.exec(s);
  return {
    files: files ? Number(files[1]) : 0,
    adds: adds ? Number(adds[1]) : 0,
    dels: dels ? Number(dels[1]) : 0,
  };
}

/**
 * Aggregate task diff numbers, using resolveTaskDiffBase with the run’s branch and start time.
 * Set repointed only when narrowed. Return null on git failure; an empty diff is all zeros.
 */
export async function worktreeShortstat(
  worktreePath: string,
  baseBranch: string,
  opts: { taskBranch?: string | undefined; runStartedAt?: string | undefined } = {},
): Promise<DiffStat | null> {
  if (!isSafeGitRef(baseBranch)) return null;
  // Private index (#1080): this runs at every turn end, beside the turn-end autosave.
  return withPrivateIndex(worktreePath, async (git) => {
    await git(['add', '-N', '.']); // intent-to-add: untracked files show up
    // `resolveTaskDiffBase` may compare two anchors with `git diff --shortstat`, so it
    // reads the private index too.
    const { base, repointedHead } = await resolveTaskDiffBase(git, baseBranch, opts);
    const res = await git(['diff', '--shortstat', base]);
    if (!res.ok) return null;
    // The key stays ABSENT (not `false`) on a normal run: `diffStat` is persisted in
    // `runs.json` and served on the runs API, so the un-narrowed shape must keep
    // round-tripping byte-identically.
    return { ...parseShortstat(res.stdout), ...(repointedHead ? { repointed: true } : {}) };
  });
}

/** The branches git's own `branch -D` guard refuses to delete, the four sources of git's
 *  `prepare_checked_out_branches` (branch.c): a worktree's checked-out branch, the branch its
 *  rebase or bisect returns to (porcelain reports those as `detached`), and the refs a paused
 *  `rebase --update-refs` will move. The state files are read from every worktree's admin
 *  directory, a missing checkout's too. Null when the registrations or a state file that exists
 *  cannot be read: a caller then treats every branch as in use. */
export async function branchesInUse(run: (args: string[]) => Promise<WorktreeGitResult>): Promise<Set<string> | null> {
  const [listed, common] = await Promise.all([
    run(['worktree', 'list', '--porcelain', '-z']),
    run(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);
  if (!listed.ok || !common.ok) return null;
  const inUse = new Set<string>();
  for (const field of listed.stdout.split('\0')) {
    if (field.startsWith('branch refs/heads/')) inUse.add(field.slice('branch refs/heads/'.length));
  }
  // A state file that exists but cannot be read is unknown, never "no reservation".
  const absent = (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  };
  try {
    const root = common.stdout.trim();
    const names = await readdir(join(root, 'worktrees')).catch(absent) ?? [];
    for (const admin of [root, ...names.map(name => join(root, 'worktrees', name))]) {
      for (const file of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
        const name = ((await readFile(join(admin, file), 'utf8').catch(absent)) ?? '').trim();
        if (name) inUse.add(name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name);
      }
      // Three lines per ref: its name, the value before the rebase, the value it will get.
      const updates = ((await readFile(join(admin, 'rebase-merge/update-refs'), 'utf8').catch(absent)) ?? '').split('\n');
      for (let i = 0; i < updates.length; i += 3) {
        if (updates[i]!.startsWith('refs/heads/')) inUse.add(updates[i]!.slice('refs/heads/'.length));
      }
    }
  } catch { return null; }
  return inUse;
}

/** A local or remote-tracking ref OUTSIDE `excluded` (full ref names) that also reaches `sha`, with
 *  its own tip — the witness a delete verifies in its transaction — or null when none does. */
export async function retainingRef(
  run: (args: string[]) => Promise<WorktreeGitResult>,
  sha: string,
  excluded: ReadonlySet<string>,
): Promise<{ ref: string; sha: string } | null> {
  const res = await run(['for-each-ref', '--contains', sha, '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads', 'refs/remotes']);
  if (!res.ok) return null;
  for (const line of res.stdout.split('\n')) {
    const [ref, tip, symref] = line.split('\0');
    // Never an alias (origin/HEAD, a symbolic branch): it may point at the very branch being
    // deleted, and a `--no-deref` verify of its name protects nothing it points at.
    if (ref && tip && !symref && !excluded.has(ref)) return { ref, sha: tip };
  }
  return null;
}

/**
 * Startup reconcile: `git worktree prune`, then remove each clean directory under
 * `.ai/cezar/worktrees/` whose run id is no longer in the store, and its branch when another
 * ref holds it. Returns the removed run ids for the boot log. Never throws.
 */
export async function pruneOrphans(
  repoRoot: string,
  validIds: ReadonlySet<string>,
): Promise<string[]> {
  return withWorktreeMutation(repoRoot, git => pruneOrphansLocked(repoRoot, validIds, git), { label: { operation: 'worktree-prune' } }).catch(() => []);
}

async function pruneOrphansLocked(repoRoot: string, validIds: ReadonlySet<string>, git: WorktreeGit): Promise<string[]> {
  const protection = await ownedCleanupProtection(repoRoot);
  if (protection.uncertain) return [];
  if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
  let entries: Dirent[];
  try {
    entries = await readdir(join(projectPaths(repoRoot).write, 'worktrees'), { withFileTypes: true });
  } catch {
    entries = []; // Fallback paths still need the read-only cleanup count.
  }
  const fallbackEntries = await readdir(join(projectPaths(repoRoot).reads[1]!, 'worktrees'), { withFileTypes: true }).catch(() => []);
  const skipped = fallbackEntries.filter(entry => entry.isDirectory() && !validIds.has(entry.name)).length;
  if (skipped) console.info(`[hsq] Orphan cleanup skipped ${skipped} read-only fallback worktree(s) under ${projectPaths(repoRoot).reads[1]}.`);
  // A missing run record alone never permits a delete (hearsay-tools/cezarion#2272): the store may
  // simply have been reset. A directory goes only on the reclaim rule (clean, HEAD kept by a ref),
  // and its branch goes only when another ref holds its tip, as the branch sweep's `empty` rule
  // (hearsay-tools/cezarion#2268). The Git view lists every kept branch as `orphan`.
  const removed: string[] = [];
  for (const entry of entries) {
    const path = worktreePathFor(repoRoot, entry.name);
    if (!entry.isDirectory() || validIds.has(entry.name) || protection.paths.has(path)) continue;
    await removeWorktreeLocked(repoRoot, path, undefined, { onlyClean: true }, git);
    await rmdir(path).catch(() => undefined); // Only an empty leftover; a directory with files stays.
    if (existsSync(path)) continue;
    await deleteKeptOrphanBranch(repoRoot, branchFor(entry.name), protection, git);
    removed.push(entry.name);
  }
  return removed;
}

/** Delete an orphan's branch only when another branch or remote-tracking ref holds its tip, the
 *  branch sweep's `empty` evidence. One ref transaction verifies that ref and the tip it read, so a
 *  commit landing in between keeps the branch. Any other branch stays for the Git view. */
async function deleteKeptOrphanBranch(repoRoot: string, branch: string, protection: OwnedCleanupProtection, git: WorktreeGit): Promise<void> {
  const ref = `refs/heads/${branch}`;
  if (protection.branches.has(branch) || (await git(repoRoot, ['symbolic-ref', '-q', ref])).ok) return;
  // `update-ref` lacks `branch -D`'s guard, so it is applied here.
  const inUse = await branchesInUse((args) => git(repoRoot, args));
  if (!inUse || inUse.has(branch)) return;
  const tip = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = tip.stdout.trim();
  if (!tip.ok || !sha) return;
  const witness = await retainingRef((args) => git(repoRoot, args), sha, new Set([ref]));
  if (!witness) return;
  const deleted = await git(repoRoot, ['update-ref', '--no-deref', '--stdin'], undefined, `verify ${witness.ref} ${witness.sha}\ndelete ${ref} ${sha}\n`);
  if (deleted.ok) await git(repoRoot, ['config', '--remove-section', `branch.${branch}`]);
}
