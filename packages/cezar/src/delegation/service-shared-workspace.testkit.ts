import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { DelegationExecutionSettings } from '../workflows/run/types.ts';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
export const shared = () => ({ task: 'review the change', workspace: 'shared' as const, requestId: randomUUID() });

/** The parent's own worktree, one commit ahead of the base: the directory a shared worker runs in. */
export function parentWorktree(f: { root: string; store: RunStore; parent: RunRecord; manager: { delegationExecutionSettings(runId: string): DelegationExecutionSettings } }): { host: string; hostHead: string } {
  const added = join(f.root, '.ai/cezar/worktrees', f.parent.id);
  git(f.root, 'worktree', 'add', '-q', '-b', 'parent-branch', added);
  writeFileSync(join(added, 'parent-work.txt'), 'committed by the parent\n');
  git(added, 'add', '.'); git(added, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'parent work');
  const hostHead = git(added, 'rev-parse', 'HEAD');
  const host = realpathSync(added);
  setRunStatus(f.store, f.parent.id, RUN_STATUS.running, { worktreePath: host, branch: 'parent-branch' });
  vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: host, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default',
    accountBinding: { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } } });
  return { host, hostHead };
}
