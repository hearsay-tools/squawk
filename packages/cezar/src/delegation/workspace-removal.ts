/** Checked removal of an owned worker workspace, on top of the record and Git layers. */
import { fallbackProjectWriteError } from '../project-paths.ts';
import { headLeftTaskBranch } from '../task-branch-head.ts';
import { entryExists as exists } from './entry-exists.ts';
import { readdir, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerDestroyResult, WorkerDestroyWork, OwnedWorkerWorkspace } from '@open-mercato/cezar-contract';
import { describeMutationHolder, withWorktreeMutation, WorktreeMutationLockTimeout, type MutationHolder } from '../git-worktree-lock.ts';
import { branchLog, checkedGit, gitCommonDir, liveGitDir, worktreeEntries } from './workspace-git.ts';
import { cleanupSchema, hash, readIdentityFile, readReceipt, RECEIPT_CAP, receiptLocation, replaceIdentityFile, validateIntent, type Cleanup, type Receipt } from './workspace-record.ts';
import { describeWork, keepingRefs, uncommittedFiles, unlandedCommits, type BranchState } from './workspace-work.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function verifyBranch(repoRoot: string, workspace: OwnedWorkerWorkspace, receipt: Receipt) {
  if (!receipt.branchIdentity) throw new Error('Branch creation identity absent');
  const log = await branchLog(repoRoot, workspace);
  const initial = receipt.branchIdentity;
  if (log.content.length < initial.prefixBytes ||
      hash(log.content.subarray(0, initial.prefixBytes)) !== initial.prefixHash) throw new Error('Branch ownership changed');
  return { sha: await checkedGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${workspace.branch}`]), log };
}
async function writeCleanup(path: string, value: Cleanup, assertCurrent?: () => void): Promise<void> {
  return replaceIdentityFile(path, JSON.stringify(value), assertCurrent);
}

/** Whether any linked worktree's admin directory still carries this resource's identity marker.
 * An unsafe or unreadable marker throws, so the caller fails closed. */
async function markerRemains(repoRoot: string, workspace: OwnedWorkerWorkspace): Promise<boolean> {
  const admin = join(await gitCommonDir(repoRoot), 'worktrees');
  if (!await exists(admin)) return false;
  for (const entry of await readdir(admin)) {
    const marker = join(admin, entry, 'cezar-owned-resource');
    if (await exists(marker) && await readIdentityFile(marker, 36, false) === workspace.resourceId) return true;
  }
  return false;
}

/** Whether `value` is still the worktree its receipt and identity marker name, at its own real path:
 * only then may destroy stop what runs there. Any doubt answers false. */
export async function ownedWorktreePresent(repoRoot: string, value: OwnedWorkerWorkspace): Promise<boolean> {
  try {
    const workspace = await validateIntent(repoRoot, value);
    const receipt = await readReceipt(await receiptLocation(repoRoot, workspace));
    return !!receipt && same(receipt.workspace, workspace) && await liveGitDir(repoRoot, workspace) === receipt.gitDir &&
      await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36, false) === workspace.resourceId;
  } catch { return false; }
}

/** How every answer for a removal that could not take the worktree mutation lock in time starts.
 * Contention clears without changing anything a destroy can observe, so a retry must not skip it
 * (hearsay-tools/cezarion#879). */
export const WORKTREE_LOCK_BUSY_PREFIX = 'Owned resources retained: worktree mutation lock is busy';

/** The lock-busy answer, naming the holder when the keeper read one (hearsay-tools/squawk#3817). */
export function worktreeLockBusyError(holder: MutationHolder | undefined): string {
  return `${WORKTREE_LOCK_BUSY_PREFIX}${holder ? `, held by ${describeMutationHolder(holder)}` : ''}; retry destroy later`;
}

/** How long a destroy waits for the lock unless its caller says otherwise: the automatic retries
 * keep this short so they never hold the queue; an explicit destroy waits longer. */
export const DEFAULT_DESTROY_LOCK_WAIT_MS = 1_000;

/** A directory with no entries; false when absent, not a directory or unreadable. */
async function emptyDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() && (await readdir(path)).length === 0; } catch { return false; }
}

/** How long the removal waits for the worktree mutation lock, and whether it may delete work. */
export interface RemovalOptions {
  waitMs?: number;
  /** Delete uncommitted changes and unlanded commits instead of refusing (hearsay-tools/squawk#3553). */
  discardWork?: boolean;
}

/**
 * Checked cleanup after persisted destroy intent and a stopped worker scope. Keep the private
 * checkpoint beyond Git-directory removal; compare exact ref/reflog identity before retrying
 * deletion. Which processes use the worktree decides nothing: the worker's own were stopped with
 * its scope, and any other is not the worker's (ADR 0032). Uncommitted changes and unlanded
 * commits refuse by name unless `discardWork` allows their deletion (hearsay-tools/squawk#3553).
 */
export async function removeOwnedWorkspace(repoRoot: string, value: OwnedWorkerWorkspace, assertCurrent?: () => void,
  beforeRemove?: () => Promise<void>, assertUnheld?: () => void, options: RemovalOptions = {}): Promise<WorkerDestroyResult> {
  const refusal = fallbackProjectWriteError(value.path);
  if (refusal) return { workerId: value.ownerRunId, state: 'incomplete', remaining: ['worktree', 'branch'], error: refusal };
  let remaining: Array<'worktree' | 'branch'> = ['worktree', 'branch'];
  let provisioned = false; let lockBusy: { holder?: MutationHolder } | undefined;
  // A refusal that names its blocker and the step that clears it.
  let named: string | undefined;
  // The work a refusal names; set only together with `named`.
  let work: WorkerDestroyWork | undefined;
  const result = (): WorkerDestroyResult => ({ workerId: value.ownerRunId, state: remaining.length ? 'incomplete' : 'complete', remaining,
    ...(remaining.length && work && !lockBusy ? { work } : {}),
    ...(remaining.length ? { error: lockBusy ? worktreeLockBusyError(lockBusy.holder)
      : named ?? 'Owned resources remain: resource identity or Git cleanup could not be verified. Check the worker worktree, Git lock and ownership receipt, then retry destroy after correcting the blocker' } : {}),
    ...(provisioned ? { deleted: [
      ...(!remaining.includes('worktree') ? [{ kind: 'worktree' as const, path: value.path }] : []),
      ...(!remaining.includes('branch') ? [{ kind: 'branch' as const, ref: `refs/heads/${value.branch}` }] : []),
    ] } : {}),
  });
  // Each early return names the check that stopped it (hearsay-tools/squawk#3817).
  const refuse = (reason: string) => { named ??= `Owned resources remain: ${reason}; retry destroy after correcting it`; };
  const refuseWork = (found: WorkerDestroyWork) => { if (named) return; named = describeWork(value.ownerRunId, found); work = found; };
  try {
    return await withWorktreeMutation(repoRoot, async mutationGit => {
      assertCurrent?.();
      const workspace = await validateIntent(repoRoot, value);
      const path = await receiptLocation(repoRoot, workspace);
      const receipt = await readReceipt(path);
      const registered = async () => worktreeEntries(await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']));
      const branchExists = async () => {
        const refs = await checkedGit(repoRoot, ['for-each-ref', '--format=%(refname)', `refs/heads/${workspace.branch}`]);
        return refs.split('\n').includes(`refs/heads/${workspace.branch}`);
      };
      if (!receipt) {
        await completeWithoutReceipt();
        return result();
      }
      if (!same(receipt.workspace, workspace)) { refuse(`the ownership receipt does not match worker ${workspace.ownerRunId}'s workspace record`); return result(); }
      provisioned = true;
      const checkpointPath = path.replace(/\.json$/, '.cleanup.json');
      let checkpoint = await exists(checkpointPath) ? cleanupSchema.parse(JSON.parse(await readIdentityFile(checkpointPath, RECEIPT_CAP))) : undefined;
      if (checkpoint && (!same(checkpoint.workspace, workspace) || checkpoint.gitDir !== receipt.gitDir)) { refuse('the cleanup checkpoint does not match the ownership receipt'); return result(); }
      if (checkpoint?.phase === 'complete') {
        await inspectCompletedCleanup(receipt);
        return result();
      }
      if (await exists(workspace.path) && !await removePresentWorktree(receipt)) return result();
      if (!checkpoint) {
        checkpoint = await prepareMissingWorktree(receipt);
        if (!checkpoint) return result();
      }
      await removeBranch(receipt, checkpoint);
      return result();

      function keepBranch(state: string): string {
        return `Owned branch ${workspace.branch} ${state}; keep what you need, delete the branch, then retry destroy`;
      }

      async function movedBranch(from: string, to: string, what: string): Promise<string> {
        const commits = Number(await checkedGit(repoRoot, ['rev-list', '--count', `${from}..${to}`]));
        return keepBranch(commits ? `holds ${commits} commit${commits === 1 ? '' : 's'} beyond ${what}` : `no longer points at ${what}`);
      }

      // Each phase shares this attempt's partial result while the mutation fence stays held.
      async function completeWithoutReceipt(): Promise<void> {
        // #878: without a receipt, the identity marker in a Git admin directory is the
        // only trace of a moved worktree. With path, registration, branch and marker all
        // gone, finish bookkeeping; write no checkpoint and delete nothing but an empty reserved directory.
        const absent = async () => !await exists(workspace.path) && !(await registered()).includes(`worktree ${workspace.path}`) &&
          !await branchExists() && !await markerRemains(repoRoot, workspace);
        // A spawn that failed in `git worktree add` before its rollback existed left only the empty
        // directory it reserved: nothing Git knows, nothing to lose.
        if (await emptyDirectory(workspace.path) && !(await registered()).includes(`worktree ${workspace.path}`)) {
          // The same checks as every other removal, after the last read and right before it.
          assertCurrent?.();
          assertUnheld?.();
          await rmdir(workspace.path).catch(() => undefined);
        }
        if (!await absent()) {
          refuse(`worktree path ${workspace.path}, its registration or branch ${workspace.branch} exists, but no ownership receipt proves the worker made it; remove what you do not need by hand`);
          return;
        }
        assertCurrent?.();
        await beforeRemove?.();
        assertCurrent?.();
        if (await absent()) remaining = [];
      }

      async function inspectCompletedCleanup(receipt: Receipt): Promise<void> {
        remaining = [];
        // Cleanup completed earlier; anything here now came back after it and is not deleted.
        if (await exists(workspace.path) || (await registered()).includes(`worktree ${workspace.path}`) || await exists(receipt.gitDir)) remaining.push('worktree');
        if (await branchExists()) remaining.push('branch');
        if (remaining.length) refuse(`cleanup completed earlier, but ${remaining.map(kind => kind === 'worktree' ? `worktree ${workspace.path}` : `branch ${workspace.branch}`).join(' and ')} exists again; it is not the worker's, so remove it by hand if you do not need it`);
      }

      async function preparePresentWorktree(receipt: Receipt): Promise<Cleanup | undefined> {
        if (checkpoint?.phase === 'worktree-removed') { refuse(`worktree path ${workspace.path} exists again after its removal was recorded`); return undefined; }
        if (await liveGitDir(repoRoot, workspace) !== receipt.gitDir ||
            await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36, false) !== workspace.resourceId) {
          refuse(`the Git admin directory or identity marker of ${workspace.path} changed since the worker was made`);
          return undefined;
        }
        named = await headLeftTaskBranch(workspace.path, workspace.branch);
        if (named) return undefined;
        // Git permits duplicate checkouts with --force. Preserve both resources
        // before the first removal if another registered path uses this branch.
        let registeredPath: string | undefined;
        for (const entry of await registered()) {
          if (entry.startsWith('worktree ')) registeredPath = entry.slice('worktree '.length);
          if (entry === `branch refs/heads/${workspace.branch}` && registeredPath !== workspace.path) {
            refuse(`branch ${workspace.branch} is also checked out at ${registeredPath ?? 'another worktree'}`);
            return undefined;
          }
        }
        const current = await verifyBranch(repoRoot, workspace, receipt);
        if (checkpoint && (checkpoint.sha !== current.sha || checkpoint.logHash !== hash(current.log.content))) {
          refuse(`branch ${workspace.branch}'s tip or reflog changed since cleanup started`);
          return undefined;
        }
        // Removing the checkout deletes its uncommitted changes, and the branch delete its unlanded
        // commits: every attempt checks both again, after the worker stopped. Without an allowed
        // discard the checkpoint is not forced, so each branch delete proves its keepers again.
        if (!options.discardWork) {
          const found = { uncommittedFiles: await uncommittedFiles(workspace.path), commits: await unlandedCommits(args => mutationGit(repoRoot, args), workspace, current) };
          if (found.uncommittedFiles || found.commits) { refuseWork(found); return undefined; }
        }
        checkpoint ??= { workspace, gitDir: receipt.gitDir, sha: current.sha, logFile: current.log.file, logHash: hash(current.log.content), phase: 'prepared',
          ...(options.discardWork ? { forced: true as const } : {}) };
        return checkpoint;
      }

      async function removePresentWorktree(receipt: Receipt): Promise<boolean> {
        const prepared = await preparePresentWorktree(receipt);
        if (!prepared) return false;
        await writeCleanup(checkpointPath, prepared, assertCurrent);
        assertCurrent?.();
        await beforeRemove?.();
        assertCurrent?.();
        assertUnheld?.();
        const removed = await mutationGit(repoRoot, ['worktree', 'remove', '--force', workspace.path]);
        if (!removed.ok) {
          // Windows refuses while another process holds a file open there; that process is never
          // signalled (ADR 0032), so the refusal names the path and Git's reason.
          named = `Owned worktree ${workspace.path} could not be removed: ${removed.stderr.trim().split('\n')[0]?.slice(0, 300) || 'git worktree remove failed'}; retry destroy after it is released`;
          return false;
        }
        remaining = ['branch'];
        return true;
      }

      async function prepareMissingWorktree(receipt: Receipt): Promise<Cleanup | undefined> {
        const worktreeGone = async () => !await exists(workspace.path) && !await exists(receipt.gitDir) &&
          !(await registered()).includes(`worktree ${workspace.path}`);
        if (!await worktreeGone()) {
          refuse(`worktree path ${workspace.path} is gone, but its Git registration or admin directory remains; check \`git worktree list\` for a lock or a moved checkout, and prune it only once you know it is stale`);
          return undefined;
        }
        if (!await branchExists()) {
          // Recorded identity already gone: finish bookkeeping. Do not delete a leftover path/gitDir/branch.
          assertCurrent?.();
          await beforeRemove?.();
          assertCurrent?.();
          if (await worktreeGone() && !await branchExists()) remaining = [];
          return undefined;
        }
        // hearsay-tools/cezarion#905: the worktree went away outside Squawk and left its branch behind.
        // While the branch matches the receipt, is checked out nowhere, and its tip and every reflog
        // entry sit at the baseline or on another ref (hearsay-tools/squawk#911), it holds no work:
        // delete it through the checkpointed compare-and-swap below, which verifies those refs too.
        // A branch reset back to its baseline may keep the worker's commits only in the reflog that
        // the delete would drop. Commits no other ref keeps are a human's call.
        remaining = ['branch'];
        if ((await registered()).includes(`branch refs/heads/${workspace.branch}`)) { refuse(`branch ${workspace.branch} is checked out at another worktree`); return undefined; }
        const current = await verifyBranch(repoRoot, workspace, receipt);
        // An allowed discard deletes the stranded commits at this tip, as for a removed checkout.
        if (!options.discardWork && !await keepers(current)) {
          await refuseStranded(current);
          return undefined;
        }
        assertCurrent?.();
        await beforeRemove?.();
        assertCurrent?.();
        return { workspace, gitDir: receipt.gitDir, sha: current.sha, logFile: current.log.file, logHash: hash(current.log.content), phase: 'prepared',
          ...(options.discardWork ? { forced: true as const } : {}) };
      }

      function keepers(branch: BranchState) { return keepingRefs(args => mutationGit(repoRoot, args), workspace, branch); }

      /** Refuses by name: the branch holds commits no other ref reaches. */
      async function refuseStranded(branch: BranchState): Promise<void> {
        refuseWork({ uncommittedFiles: 0, commits: await unlandedCommits(args => mutationGit(repoRoot, args), workspace, branch) });
      }

      /** The refs the branch delete verifies. Unless a discard is allowed (`forced` on the checkpoint,
       * bound to the unchanged tip, or `discardWork` on this attempt), prove on every attempt that no work is lost
       * (hearsay-tools/squawk#911); the proof takes several Git calls, so the branch and its reflog
       * are read once more, last. Undefined when the proof fails or the branch changed. */
      async function deletionWitnesses(receipt: Receipt, checkpoint: Cleanup, current: Awaited<ReturnType<typeof verifyBranch>>) {
        if (checkpoint.forced || options.discardWork) return [];
        const witnesses = await keepers(current);
        if (!witnesses) { await refuseStranded(current); return undefined; }
        const last = await verifyBranch(repoRoot, workspace, receipt);
        return last.sha === checkpoint.sha && hash(last.log.content) === checkpoint.logHash ? witnesses : undefined;
      }

      async function removeBranch(receipt: Receipt, checkpoint: Cleanup): Promise<void> {
        if (await exists(workspace.path) || await exists(receipt.gitDir) || (await registered()).includes(`worktree ${workspace.path}`)) {
          refuse(`worktree path ${workspace.path}, its registration or its Git admin directory is still present after removal`);
          return;
        }
        remaining = ['branch'];
        checkpoint = { ...checkpoint, phase: 'worktree-removed' };
        await writeCleanup(checkpointPath, checkpoint, assertCurrent);
        if (await branchExists()) {
          if ((await registered()).includes(`branch refs/heads/${workspace.branch}`)) { refuse(`branch ${workspace.branch} is checked out at another worktree`); return; }
          const current = await verifyBranch(repoRoot, workspace, receipt);
          // hearsay-tools/squawk#910: a tip that moved after the checkpoint is named like a stranded one.
          if (current.sha !== checkpoint.sha) { named = await movedBranch(checkpoint.sha, current.sha, 'the tip destroy recorded'); return; }
          if (hash(current.log.content) !== checkpoint.logHash) { refuse(`branch ${workspace.branch}'s reflog changed since cleanup started`); return; }
          const witnesses = await deletionWitnesses(receipt, checkpoint, current);
          if (!witnesses) { refuse(`branch ${workspace.branch} changed while destroy checked which refs keep its commits`); return; }
          // Ref CAS: never delete a branch advanced after our verified snapshot.
          assertCurrent?.();
          assertUnheld?.();
          // The refs that keep its commits must not have moved either: one ref transaction checks them.
          // --no-deref deletes a branch replaced by a symbolic ref, never the ref it points at
          // (hearsay-tools/squawk#3619).
          const removed = await mutationGit(repoRoot, ['update-ref', '--no-deref', '--stdin'], undefined,
            [...witnesses.map(({ ref, sha }) => `verify ${ref} ${sha}`), `delete refs/heads/${workspace.branch} ${checkpoint.sha}`].join('\n') + '\n');
          if (!removed.ok || await branchExists()) {
            refuse(`deleting branch ${workspace.branch} failed: ${removed.stderr.trim().split('\n')[0]?.slice(0, 300) || 'the branch still exists'}`);
            return;
          }
        }
        await writeCleanup(checkpointPath, { ...checkpoint, phase: 'complete' }, assertCurrent);
        remaining = [];
      }
    }, { waitMs: options.waitMs ?? DEFAULT_DESTROY_LOCK_WAIT_MS, label: { operation: 'worker-destroy', owner: value.ownerRunId } });
  } catch (error) {
    // Ambiguous ownership and every failed Git/filesystem operation fail closed, naming what failed.
    if (error instanceof WorktreeMutationLockTimeout) lockBusy = { ...(error.holder ? { holder: error.holder } : {}) };
    else refuse(`a destroy check failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
  }
  return result();
}
