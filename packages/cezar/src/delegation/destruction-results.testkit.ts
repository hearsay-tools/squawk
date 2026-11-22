// Its fixtures delete, reclaim or archive runs, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { ProjectRunManager } from '../server/project-context.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import type { Caller } from './credentials.ts';
import type { DelegationService } from './service.ts';
import { ensureOwnedWorkspace } from './workspace.ts';

type Fixture = { root: string; store: RunStore; parent: RunRecord; caller: Caller; service: DelegationService; manager: Pick<ProjectRunManager, 'requestWorkerStop'> };

// Each worker here holds an uncommitted `result.txt` whose evidence these tests follow, so every
// destroy allows its discard (hearsay-tools/squawk#3553).
export const DISCARD = { discardWork: true };

/** A worker whose execution completed in review, with an uncommitted result, a summary and a copied input.
 *  The test file mocks `node:fs` so `rmSync` is a `vi.fn`. */
export async function completedWorker(f: Fixture) {
  const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
  const run = f.store.getRun(workerId)!;
  f.manager.requestWorkerStop(workerId); // remove held scheduler admission before simulating a completed execution
  const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId);
  const workspace = await ensureOwnedWorkspace(f.root, run);
  writeFileSync(join(workspace.path, 'result.txt'), 'retained patch');
  f.store.appendEvent(workerId, { type: 'text', text: 'Completed implementation' });
  setRunStatus(f.store, workerId, RUN_STATUS.review, { worktreePath: workspace.path, branch: workspace.branch });
  expect(f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
  const files = join(f.root, '.ai/cezar/runs');
  mkdirSync(join(files, `${workerId}-images`));
  writeFileSync(join(files, `${workerId}-images/worker-context-0.input`), 'copied input');
  writeFileSync(join(files, `${workerId}.handoff.md`), 'handoff');
  f.store.appendEvent(workerId, { type: 'image', url: `/api/v1/runs/${workerId}/images/worker-context-0.input` });
  return { workerId, workspace, generation, files };
}

/** The finished parent's history deletion fails once, leaving its retry marker. */
export function interruptParentDeletion(f: Fixture): void {
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
  f.store.addStep(f.parent.id, { id: 'task', name: 'Task', kind: STEP_KIND.agent });
  f.store.updateStep(f.parent.id, 'task', { status: STEP_STATUS.done, sessionId: 'mock-prior', backend: 'claude' });
  setRunStatus(f.store, f.parent.id, RUN_STATUS.done, { workflowDef: QUICK_TASK_WORKFLOW, task: 'mock:cezar-done', worktreePath: undefined });
  vi.mocked(rmSync).mockImplementationOnce(() => { throw Error('history temporarily busy'); });
  expect(f.store.retention.deleteRun(f.parent.id)).toBe(false);
  expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ historyDeletion: 'pending' });
}
