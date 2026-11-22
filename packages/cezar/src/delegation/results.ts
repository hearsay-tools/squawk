import { runDataDir } from '../legacy-runs.ts';
import { projectPaths } from '../project-paths.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerCollectedResult } from '@open-mercato/cezar-contract';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import type { RunEvent, RunRecord, RunStore } from '../runs/store.ts';
import { isAttachmentFileName, resolveAttachmentPath } from '../workflows/attachment-path.ts';
import { workspaceDirectoryRemoved, workspaceKindOf } from './workspace-kinds.ts';
import { artifactDirectory, listArtifacts, readArtifact } from '../artifacts/store.ts';
import { workerObservation } from '../runs/delegation-state.ts';

export const workerRevision = (run: RunRecord): number => run.delegation?.role === 'worker' ? run.delegation.executionRevision ?? 0 : 0;

/** The text of a top-level assistant message event, v1 `text` or v2 `item.completed`; the newest
 *  one is what `collect` reports and what a park notice quotes (hearsay-tools/cezarion#1327). */
export function topLevelAssistantText(event: RunEvent): string | undefined {
  const item = event.item as { kind?: string; role?: string; text?: string; parentItemId?: string } | undefined;
  const text = event.type === 'text' && !event.parentItemId ? event.text
    : event.type === 'item.completed' && item?.kind === 'message' && item.role === 'assistant' && item.parentItemId === undefined ? item.text : undefined;
  return typeof text === 'string' ? text : undefined;
}

/** Snapshot collection is deliberately read-only until the service rechecks lifecycle identity. */
export async function collectWorkerEvidence(repoRoot: string, store: RunStore, run: RunRecord): Promise<{ result: WorkerCollectedResult; diffSnapshot?: string }> {
  if (run.delegation?.role !== 'worker') throw Error('missing worker ownership');
  const delegation = run.delegation;
  const previous = store.workerResults.readWorkerResult(delegation.parentRunId, run.id);
  // One async read (#880): an archived transcript decodes with the async brotli API.
  const allEvents = await store.eventLog.readEventsAsync(run.id);
  const events = allEvents.filter(event => event.seq > (delegation.executionStartSeq ?? -1));
  const summary = run.status === 'failed' && run.error?.trim() ? failureSummary(run.error, events) : latestAssistantSummary(events);
  const destroyed = delegation.destroy?.phase === 'complete';
  const workspaceRemoved = !!delegation.destroy && workspaceDirectoryRemoved(delegation.workspace, delegation.destroy.remaining);
  const { lastExecutionOutcome } = executionOutcome(run);
  const observation = workerObservation(run, store.workerExecutions.readWorkerExecution(run.id));
  const head = await readWorkerHead(repoRoot, run, previous, workspaceRemoved);
  const { diff, diffSnapshot } = await readWorkerDiff(repoRoot, store, run, delegation, { destroyed, workspaceRemoved });
  const changes = await readWorkspaceChanges(store, run);
  const artifacts = await listWorkerArtifacts(store.sourceDataDir(run.id), run, delegation, allEvents);
  return { result: {
    workerId: run.id, parentRunId: delegation.parentRunId, revision: workerRevision(run), observedAt: new Date().toISOString(),
    status: run.status, outcome: destroyed ? 'destroyed' : lastExecutionOutcome, lastExecutionOutcome,
    ...observation,
    ...(run.error ? { error: run.error.slice(0, 2000) } : {}),
    ...(run.runner ? { backend: run.runner } : {}), ...(run.model ? { model: run.model } : {}),
    baselineSha: delegation.workspace.baselineSha, workspace: { ...delegation.workspace, state: workspaceRemoved ? 'deleted' : head.state === 'available' ? 'available' : 'unavailable' }, cleanup: delegation.destroy?.phase ?? 'retained',
    summary, head, diff, ...changes, artifacts,
  }, ...(diffSnapshot === undefined ? {} : { diffSnapshot }) };
}

/** The kind's report of what changed in the workspace's directory, for the worker's current execution.
 *  Only a worker that is queued, running or waiting counts as still running: one that stopped in any
 *  other way, with or without a complete execution record, is never compared with the directory as it is. */
async function readWorkspaceChanges(store: RunStore, run: RunRecord): Promise<Pick<WorkerCollectedResult, 'changes'>> {
  const changes = await workspaceKindOf(run).changeReport(store.sourceDataDir(run.id), run,
    { generation: store.workerExecutions.readWorkerExecution(run.id)?.generation, settled: !isLiveStatus(run.status) });
  return changes ? { changes } : {};
}

/** The newest non-blank top-level assistant text of this execution, bounded to 4000 characters. */
function latestAssistantSummary(events: RunEvent[]): WorkerCollectedResult['summary'] {
  let summary: WorkerCollectedResult['summary'] = { state: 'unavailable', reason: 'no-assistant-output' };
  for (const event of events) {
    const text = topLevelAssistantText(event);
    if (text?.trim()) summary = { state: 'available', text: text.slice(0, 4000), source: 'assistant', seq: event.seq, truncated: text.length > 4000 };
  }
  return summary;
}

/** A failed worker's summary names the runner's failure reason, so its parent can act on it without
 *  reading the transcript (hearsay-tools/squawk#3337). It takes precedence over the last assistant text. */
function failureSummary(error: string, events: RunEvent[]): WorkerCollectedResult['summary'] {
  const text = `Runner failure: ${error.trim()}`;
  return { state: 'available', text: text.slice(0, 4000), source: 'failure', seq: events.at(-1)?.seq ?? 0, truncated: text.length > 4000 };
}

/** The public status as an execution outcome. Settlement also needs private termination proof. */
function executionOutcome(run: RunRecord): { lastExecutionOutcome: WorkerCollectedResult['lastExecutionOutcome'] } {
  const lastExecutionOutcome = run.status === 'review' ? 'review-ready' : run.status === 'done' ? 'completed'
    : run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'running';
  return { lastExecutionOutcome };
}

/** The owned workspace's verified HEAD. A failed read keeps the last collected SHA: `unverified`, or `deleted` once the worktree is removed. */
async function readWorkerHead(repoRoot: string, run: RunRecord, previous: WorkerCollectedResult | undefined, workspaceRemoved: boolean): Promise<WorkerCollectedResult['head']> {
  const historicalSha = previous?.head && 'sha' in previous.head ? previous.head.sha : undefined;
  let head: WorkerCollectedResult['head'] = { state: workspaceRemoved ? 'deleted' : 'unavailable', reason: 'missing', ...(historicalSha ? { sha: historicalSha } : {}) };
  try {
    const sha = await workspaceKindOf(run).readHead(repoRoot, run);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw Error('invalid HEAD');
    head = { state: 'available', sha };
  } catch { if (!workspaceRemoved) head = { state: 'unavailable', reason: 'unverified', ...(historicalSha ? { sha: historicalSha } : {}) }; }
  return head;
}

type WorkerDelegation = Extract<NonNullable<RunRecord['delegation']>, { role: 'worker' }>;

/** The owned workspace's diff, or this revision's retained snapshot when the live read fails. */
async function readWorkerDiff(repoRoot: string, store: RunStore, run: RunRecord, delegation: WorkerDelegation, cleanup: { destroyed: boolean; workspaceRemoved: boolean }): Promise<{ diff: WorkerCollectedResult['diff']; diffSnapshot: string | undefined }> {
  const noDiff = workspaceKindOf(run).noDiff;
  if (noDiff) return { diff: { state: 'unavailable', reason: 'unsupported', detail: noDiff }, diffSnapshot: undefined };
  let diff: WorkerCollectedResult['diff'] = { state: cleanup.workspaceRemoved ? 'deleted' : 'unavailable', reason: 'missing' };
  let diffSnapshot: string | undefined;
  try {
    const observation = await workspaceKindOf(run).readDiff(repoRoot, run);
    diffSnapshot = observation.diff;
    const snapshotId = randomUUID();
    diff = { state: 'available', snapshotId, path: store.workerResults.workerResultSnapshotPath(delegation.parentRunId, run.id, snapshotId), truncated: observation.truncated };
  } catch { if (!cleanup.destroyed) diff = { state: 'unavailable', reason: 'unverified' }; }
  // Re-read after the live workspace checks. A concurrent reclaim can commit a
  // snapshot while this collect still holds a `previous` captured as undefined.
  if (diffSnapshot === undefined) {
    const stored = store.workerResults.readWorkerResult(delegation.parentRunId, run.id);
    if (stored?.revision === workerRevision(run) && stored.diff.state === 'available') {
      const retained = store.workerResults.readWorkerResultDiff(delegation.parentRunId, run.id);
      if (retained !== undefined) { diffSnapshot = retained; diff = { ...stored.diff, snapshotId: randomUUID() }; }
    }
  }
  return { diff, diffSnapshot };
}

/** Published artifacts, newest first, then image and parent-attachment descriptors; at most 32. */
async function listWorkerArtifacts(dataDir: string, run: RunRecord, delegation: WorkerDelegation, allEvents: RunEvent[]): Promise<WorkerCollectedResult['artifacts']> {
  const ids = new Set<string>();
  for (const event of allEvents) {
    if (event.type !== 'image' || typeof event.url !== 'string') continue;
    const match = event.url.match(new RegExp(`^/api/(?:v1/)?runs/${run.id}/images/([^/]+)$`));
    if (match && isAttachmentFileName(match[1]!) && match[1]!.length <= 255) ids.add(match[1]!);
  }
  for (const input of delegation.context?.inputs ?? []) if (input.source.kind === 'parent-attachment') {
    const name = input.path.split('/').at(-1)!; if (isAttachmentFileName(name)) ids.add(name);
  }
  const published = await listArtifacts(artifactDirectory(dataDir, run.id), run.id);
  const publishedItems = published.slice().reverse().map(item => ({ state: 'available' as const, id: `published:${item.id}`, path: join(artifactDirectory(dataDir, run.id), item.id, 'content') }));
  const items: Extract<WorkerCollectedResult['artifacts'], { state: 'available' }>['items'] = [...publishedItems, ...[...ids].map((id): Extract<WorkerCollectedResult['artifacts'], { state: 'available' }>['items'][number] => {
    const path = join(runDataDir(dataDir, run.id), 'runs', `${run.id}-images`, id);
    if (resolveAttachmentPath(dataDir, run.id, id)) return { state: 'available', id, path };
    return existsSync(path) ? { state: 'unavailable', reason: 'unreadable', id, path } : { state: 'deleted', reason: 'missing', id, path };
  })].slice(0, 32);
  return { state: 'available', items, truncated: ids.size + published.length > 32 };
}

/** History deletion retains observation bytes, not attachment files or live Git refs. */
export async function revalidateRetainedWorkerResult(repoRoot: string, previous: WorkerCollectedResult, dataDir = projectPaths(repoRoot).write): Promise<WorkerCollectedResult> {
  return { ...previous, observedAt: new Date().toISOString(),
    head: previous.head.state === 'available' ? { state: 'unavailable', reason: 'unverified', sha: previous.head.sha } : previous.head,
    diff: previous.diff.state === 'available' ? { ...previous.diff, snapshotId: randomUUID() } : previous.diff,
    artifacts: previous.artifacts.state !== 'available' ? previous.artifacts : { ...previous.artifacts,
      items: await Promise.all(previous.artifacts.items.map(async item => {
        if (item.id.startsWith('published:')) {
          const available = await readArtifact(artifactDirectory(dataDir, previous.workerId), previous.workerId, item.id.slice('published:'.length));
          return available ? { state: 'available' as const, id: item.id, path: item.path }
            : { state: 'deleted' as const, reason: 'missing' as const, id: item.id, path: item.path };
        }
        return resolveAttachmentPath(dataDir, previous.workerId, item.id)
          ? { state: 'available' as const, id: item.id, path: item.path }
          : existsSync(join(runDataDir(dataDir, previous.workerId), 'runs', `${previous.workerId}-images`, item.id))
            ? { state: 'unavailable' as const, reason: 'unreadable' as const, id: item.id, path: item.path }
            : { state: 'deleted' as const, reason: 'missing' as const, id: item.id, path: item.path };
      })),
    },
  };
}
