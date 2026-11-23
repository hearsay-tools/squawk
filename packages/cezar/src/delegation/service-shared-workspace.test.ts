import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SHARED_ATTACH_REFUSAL, SHARED_BASELINE_REFUSAL } from '@open-mercato/cezar-contract/delegation';
import { workerCapacity } from './capacity.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { fixture } from './service.testkit.ts';
import { git, parentWorktree, shared } from './service-shared-workspace.testkit.ts';
import { workerCleanups } from './worker-cleanup.ts';
import { ownedWorkspaceReceipts } from './workspace-record.ts';

sealTestRunners(claudeRunner);

const mutationLock = vi.hoisted(() => ({ taken: 0 }));
vi.mock('../git-worktree-lock.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../git-worktree-lock.ts')>();
  return { ...actual, withWorktreeMutation: ((...args: Parameters<typeof actual.withWorktreeMutation>) => { mutationLock.taken += 1; return actual.withWorktreeMutation(...args); }) as typeof actual.withWorktreeMutation };
});

let f: ReturnType<typeof fixture>;
/** The parent's own worktree: the directory a shared worker runs in. */
let host: string;
let hostHead: string;

const worker = (workerId: string) => f.store.getRun(workerId)!;

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
  onTestFinished(scopeFixtureProcesses());
  mutationLock.taken = 0;
  f = fixture(workerCleanups());
  ({ host, hostHead } = parentWorktree(f));
});
afterEach(async () => {
  try { await f.close(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe('a worker in a shared workspace (hearsay-tools/squawk#3819)', { timeout: 60_000 }, () => {
  it('is spawned at the parent\'s HEAD with no worktree, no branch and no owned-workspace receipt', async () => {
    const spawned = await f.service.spawn(f.caller, shared());
    expect(spawned.baselineSha).toBe(hostHead);
    expect(hostHead).not.toBe(f.sha);
    const run = worker(spawned.workerId);
    expect(run.delegation).toMatchObject({ role: 'worker', parentRunId: f.parent.id,
      workspace: { ownerRunId: run.id, resourceId: expect.any(String), kind: 'shared', path: host, hostRunId: f.parent.id, baselineSha: hostHead } });
    expect(run.delegation?.role === 'worker' && 'branch' in run.delegation.workspace).toBe(false);
    expect(run.worktreePath).toBeUndefined(); expect(run.branch).toBeUndefined();
    expect(existsSync(join(f.root, '.ai/cezar/worktrees', run.id))).toBe(false);
    expect(git(f.root, 'branch', '--list', `cez/${run.id.slice(0, 8)}`)).toBe('');
    expect(await ownedWorkspaceReceipts(f.root)).toEqual([]);
    expect(mutationLock.taken).toBe(0);
    expect((await f.service.inspect(f.caller, { workerId: run.id })).workspace).toMatchObject({ kind: 'shared', path: host });
  });

  it('refuses --baseline and --attach with clear words, and creates no worker', async () => {
    await expect(f.service.spawn(f.caller, { ...shared(), baseline: 'main' })).rejects.toMatchObject({ code: 'invalid_input', message: SHARED_BASELINE_REFUSAL });
    expect(SHARED_BASELINE_REFUSAL).toContain('leave --baseline out or pass parent-head');
    await expect(f.service.spawn(f.caller, { ...shared(), context: { artifacts: [{ kind: 'parent-file', path: '.env' }] } }))
      .rejects.toMatchObject({ code: 'invalid_input', message: SHARED_ATTACH_REFUSAL });
    await expect(f.service.spawn(f.caller, { task: 'isolated without a baseline', requestId: randomUUID() })).rejects.toThrow();
    expect(f.store.queries.listWorkerIds()).toEqual([]);
  });

  it('returns the same worker for the same request, with or without --baseline parent-head, and refuses another kind under the same request id', async () => {
    const request = shared();
    const first = await f.service.spawn(f.caller, request);
    expect(await f.service.spawn(f.caller, request)).toEqual(first);
    // `parent-head` names the HEAD a shared worker runs at anyway: the same request, the same worker.
    expect(await f.service.spawn(f.caller, { ...request, baseline: 'parent-head' })).toEqual(first);
    expect(first.baselineSha).toBe(hostHead);
    await expect(f.service.spawn(f.caller, { task: request.task, baseline: 'parent-head', requestId: request.requestId }))
      .rejects.toMatchObject({ code: 'invalid_input', message: 'Request ID payload conflict' });
    await expect(f.service.spawn(f.caller, { ...request, workspace: 'isolated', baseline: 'parent-head' }))
      .rejects.toMatchObject({ message: 'Request ID payload conflict' });
    expect(f.store.queries.listWorkerIds()).toEqual([first.workerId]);
  });

  it('keeps an isolated request\'s identity whether or not it names the default workspace', async () => {
    const request = { task: 'isolated', baseline: 'parent-head', requestId: randomUUID() };
    const first = await f.service.spawn(f.caller, request);
    expect(await f.service.spawn(f.caller, { ...request, workspace: 'isolated' })).toEqual(first);
    expect(worker(first.workerId).delegation).toMatchObject({ workspace: { kind: 'owned-isolated' } });
  });

  it('counts toward the parent\'s 32 outstanding workers', async () => {
    for (let n = 0; n < 32; n++) await f.service.spawn(f.caller, shared());
    expect(workerCapacity(f.store.getRun(f.parent.id)!, id => f.store.getRun(id))).toMatchObject({ outstanding: 32, created: 32 });
    await expect(f.service.spawn(f.caller, shared())).rejects.toMatchObject({ code: 'capacity_limit' });
  });
});
