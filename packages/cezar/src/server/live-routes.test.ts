import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { LIVE_BYTE_LIMIT } from '@open-mercato/cezar-contract/live-limits';
import { liveRunBatchResponseSchema, type LiveRunBatch } from '@open-mercato/cezar-contract/live';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { lifecycleListeners } from '../runs/lifecycle-listeners.testkit.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
// Its runs are deleted, reclaimed or archived, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';

let root: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
let runId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-live-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  runId = store.createRun({ title: 'Stream', workflow: 'quick-task', task: 'Stream', steps: [] }).id;
  app = createApp({ home: testHome(), repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: 'boot' });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
const batch = (runs: unknown[]) => apiRequest(app, '/api/v1/workspace/run-event-batches', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs }),
});

/** One SSE stream: read until a marker, list one event's data lines, abort. */
async function openSse(path: string) {
  const controller = new AbortController();
  const reader = (await apiRequest(app, path, { signal: controller.signal })).body!.getReader();
  const decoder = new TextDecoder();
  let wire = '';
  return {
    async until(marker: string): Promise<void> {
      while (!wire.includes(marker)) {
        const next = await reader.read();
        if (next.done) throw new Error(`stream ended before ${marker}`);
        wire += decoder.decode(next.value, { stream: true });
      }
    },
    frames: (event: string) => [...wire.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n`, 'g'))].map((match) => match[1]),
    async close(): Promise<void> { controller.abort(); await reader.cancel(); },
  };
}

describe('finite multi-run catch-up', () => {
  it('delivers current text before item completion without persisting streaming deltas', async () => {
    const sink = new UiEventSink({
      persist: event => { store.eventLog.appendEvent(runId, event); },
      emitLive: event => { store.eventLog.emitEphemeral(runId, event); },
    });
    const item = { kind: 'message' as const, id: 'typing', role: 'assistant' as const, text: '' };
    sink.handle({ type: 'item.started', item });
    const first = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).json()).results[0] as LiveRunBatch;
    sink.handle({ type: 'item.delta', itemId: item.id, field: 'text', delta: 'Still ' });
    sink.flushAll();
    sink.handle({ type: 'item.delta', itemId: item.id, field: 'text', delta: 'writing' });
    sink.flushAll();
    store.eventLog.appendEvent(runId, { type: 'note', text: 'unrelated persisted event' });
    const next = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: first.afterSeq, cursor: first.cursor }])).json()).results[0] as LiveRunBatch;
    expect(next.events.map(event => event.seq)).toEqual([3, 4]);
    expect(next.events[0]).toMatchObject({ type: 'item.updated', item: { text: 'Still writing' } });
    sink.handle({ type: 'item.updated', item: { ...item, text: 'Still writing more' } });
    const last = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: next.afterSeq, cursor: next.cursor }])).json()).results[0] as LiveRunBatch;
    expect(last.events).toMatchObject([{ type: 'item.updated', item: { text: 'Still writing more' } }]);
    expect(store.eventLog.readEvents(runId).map(event => event.type)).toEqual(['item.started', 'note']);
    const duplicate = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: last.afterSeq, cursor: last.cursor }])).json()).results[0] as LiveRunBatch;
    expect(duplicate.events).toEqual([]);
    sink.handle({ type: 'item.completed', item: { ...item, text: 'Finished' } });
    const completed = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: last.afterSeq, cursor: last.cursor }])).json()).results[0] as LiveRunBatch;
    expect(completed.events).toMatchObject([{ type: 'item.completed', item: { text: 'Finished' } }]);
  });
  it.each([[false, false], [true, false], [false, true]])('does not acknowledge writes newer than its captured snapshots (prior live text: %s, cold store: %s)', async (priorText, cold) => {
    store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    if (priorText) store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'before ' });
    if (cold) {
      store.close(); store = RunStore.open(join(root, '.ai/cezar'));
      app = createApp({ home: testHome(), repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: 'boot' });
    }
    const other = store.createRun({ title: 'Other', task: 'Other', workflow: 'quick-task', steps: [] }).id;
    const listeners = lifecycleListeners(store.lifecycle);
    const before = listeners('run.event');
    const capture = store.liveReadSnapshot.bind(store);
    vi.spyOn(store, 'liveReadSnapshot').mockImplementationOnce(id => {
      const snapshot = capture(id);
      // The history scanner awaits filesystem IO after capturing live state.
      queueMicrotask(() => {
        store.eventLog.emitEphemeral(other, { type: 'item.delta', itemId: 'other', field: 'text', delta: 'unrelated' });
        if (cold) store.eventLog.emitEphemeral(runId, { type: 'item.updated', item: { id: 'typing', kind: 'message', text: 'during scan' } });
        else store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'during scan' });
        store.eventLog.appendEvent(runId, { type: 'note', text: 'persisted during scan' });
      });
      return snapshot;
    });
    const first = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).json()).results[0] as LiveRunBatch;
    expect(first.afterSeq).toBe(priorText ? 2 : 1);
    expect(first.hasMore).toBe(true);
    if (priorText) expect(first.events.at(-1)).toMatchObject({ type: 'item.updated', item: { text: 'before ' } });
    const next = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: first.afterSeq, cursor: first.cursor }])).json()).results[0] as LiveRunBatch;
    expect(next.events).toMatchObject([
      { type: 'item.updated', item: { text: priorText ? 'before during scan' : 'during scan' } },
      { type: 'note', text: 'persisted during scan' },
    ]);
    expect(next.hasMore).toBe(false);
    expect(listeners('run.event')).toBe(before);
  });
  it('merges active snapshots at an event-limit boundary without skipping persisted records', async () => {
    store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    for (let i = 0; i < 254; i++) store.eventLog.appendEvent(runId, { type: 'note', text: 'history' });
    store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'live text' });
    store.eventLog.appendEvent(runId, { type: 'note', text: 'after live text' });
    const first = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).json()).results[0] as LiveRunBatch;
    expect(first.events).toHaveLength(256);
    expect(first.events.at(-1)).toMatchObject({ seq: 256, type: 'item.updated', item: { text: 'live text' } });
    expect(first.hasMore).toBe(true);
    const next = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: first.afterSeq, cursor: first.cursor }])).json()).results[0] as LiveRunBatch;
    expect(next.events).toMatchObject([{ seq: 257, text: 'after live text' }]);
    expect(next.hasMore).toBe(false);
  });
  it('retains only redacted active content and clears it on store closure', async () => {
    store.redaction.registerSessionSecret('fixture-secret-must-be-redacted');
    store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'fixture-secret-must-be-redacted' });
    const response = await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).text();
    expect(response).not.toContain('fixture-secret-must-be-redacted');
    expect(response).toContain('[REDACTED]');
    expect(store.liveReadSnapshot(runId).events).toHaveLength(1);
    store.close();
    expect(store.liveReadSnapshot(runId).events).toEqual([]);
  });
  it('discards active snapshots when their run is deleted', () => {
    store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'temporary' });
    setRunStatus(store, runId, RUN_STATUS.done);
    expect(store.liveReadSnapshot(runId).events).toHaveLength(1);
    expect(store.retention.deleteRun(runId)).toBe(true);
    expect(store.liveReadSnapshot(runId).events).toEqual([]);
  });
  it('bounds replay at an accepted prefix and continues without loss or duplicates', async () => {
    for (let i = 0; i < 300; i++) store.eventLog.appendEvent(runId, { type: 'note', text: `line ${i}` });
    const first = await batch([{ projectId: 'default', runId, afterSeq: 0 }]);
    expect(first.status).toBe(200);
    const a = liveRunBatchResponseSchema.parse(await first.json()).results[0] as LiveRunBatch;
    expect(a.events).toHaveLength(256);
    expect(a.hasMore).toBe(true);
    expect(a.afterSeq).toBe(256);
    const second = await batch([{ projectId: 'boot', runId, afterSeq: a.afterSeq, cursor: a.cursor }]);
    const b = liveRunBatchResponseSchema.parse(await second.json()).results[0] as LiveRunBatch;
    expect(b.events.map((e: { seq: number }) => e.seq)).toEqual(Array.from({ length: 44 }, (_, i) => i + 257));
    expect(b.hasMore).toBe(false);
    expect(a.projectId).toBe('boot');
  });
  it('reports a missing task without losing the other requested transcript', async () => {
    store.eventLog.appendEvent(runId, { type: 'note', text: 'survives' });
    const response = await batch([{ projectId: 'boot', runId: 'gone', afterSeq: 0 }, { projectId: 'boot', runId, afterSeq: 0 }]);
    expect(response.status).toBe(200);
    const { results } = liveRunBatchResponseSchema.parse(await response.json());
    expect(results[0]).toMatchObject({ type: 'error', status: 404 });
    expect((results[1] as LiveRunBatch).events[0]!.text).toBe('survives');
  });
  it('rejects duplicate demand, malformed names and excessive demand at the boundary', async () => {
    const demand = { projectId: 'boot', runId, afterSeq: 0 };
    expect((await batch([demand, demand])).status).toBe(400);
    expect((await batch([demand, { ...demand, projectId: 'default' }])).status).toBe(400);
    expect((await batch([{ ...demand, runId: '../escape' }])).status).toBe(400);
    expect((await batch(Array.from({ length: 33 }, (_, i) => ({ ...demand, runId: `run-${i}` })))).status).toBe(400);
  });
  it('keeps sequence gaps while filtering the already accepted prefix', async () => {
    store.eventLog.appendEvent(runId, { type: 'note', text: 'first' });
    store.eventLog.appendEvent(runId, { type: 'note', text: 'second' });
    const response = await batch([{ projectId: 'boot', runId, afterSeq: 1 }]);
    expect(response.status).toBe(200);
    expect((liveRunBatchResponseSchema.parse(await response.json()).results[0] as LiveRunBatch).events.map((e: { seq: number }) => e.seq)).toEqual([2]);
  });
});

describe('multiplexed live task feed', () => {
  it('isolates project errors, replays healthy demand and releases listeners on cancellation', async () => {
    store.eventLog.appendEvent(runId, { type: 'note', text: 'healthy transcript' });
    const controller = new AbortController();
    const listeners = lifecycleListeners(store.lifecycle);
    const before = listeners('run.event');
    const response = await apiRequest(app, '/api/v1/workspace/run-events', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [{ projectId: 'unknown', runId, afterSeq: 0 }, { projectId: 'boot', runId, afterSeq: 0 }] }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let wire = '';
    try {
      while (!wire.includes('healthy transcript') || !wire.includes('"type":"error"')) {
        const next = await reader.read();
        if (next.done) throw new Error('stream ended before replay');
        wire += new TextDecoder().decode(next.value);
      }
      expect(wire).toContain('"projectId":"unknown"');
      expect(wire).toContain('"projectId":"boot"');
      expect(listeners('run.event')).toBe(before + 1);
    } finally { controller.abort(); await reader.cancel(); }
    expect(listeners('run.event')).toBe(before);
  });
  it('keeps the old per-run SSE route and large records compatible', async () => {
    const text = 'x'.repeat(1024 * 1024 + 10);
    store.eventLog.appendEvent(runId, { type: 'note', text });
    const controller = new AbortController();
    const response = await apiRequest(app, `/api/v1/runs/${runId}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let size = 0;
    try {
      while (size < text.length) {
        const { value, done } = await reader.read();
        if (done) throw new Error('legacy replay truncated');
        size += value.length;
      }
      expect(size).toBeGreaterThan(text.length);
    } finally { controller.abort(); await reader.cancel(); }
  });
  it('sends its own run record on every write and releases its subscription on abort', async () => {
    const listeners = lifecycleListeners(store.lifecycle);
    const initial = JSON.stringify(store.getRun(runId));
    const stream = await openSse(`/api/v1/runs/${runId}/events`);
    try {
      await stream.until('event: ping');
      expect([listeners('run.created'), listeners('run.updated')]).toEqual([1, 1]);
      store.createRun({ title: 'Other', workflow: 'quick-task', task: 'Other', steps: [] });
      store.updateRun(runId, { title: 'Renamed' });
      const renamed = JSON.stringify(store.getRun(runId));
      await stream.until('"title":"Renamed"');
      expect(stream.frames('run')).toEqual([initial, renamed]);
    } finally { await stream.close(); }
    expect([listeners('run.created'), listeners('run.updated')]).toEqual([0, 0]);
  });
  it('sends every run write and delete on the project feed and releases its subscription on abort', async () => {
    const listeners = lifecycleListeners(store.lifecycle);
    const held = () => [listeners('run.created'), listeners('run.updated'), listeners('run.deleted')];
    const stream = await openSse('/api/v1/events');
    try {
      await stream.until('event: ping');
      expect(held()).toEqual([1, 1, 1]);
      const other = store.createRun({ title: 'Other', workflow: 'quick-task', task: 'Other', steps: [] });
      const created = JSON.stringify(other);
      store.updateRun(other.id, { title: 'Renamed' });
      const renamed = JSON.stringify(store.getRun(other.id));
      expect(store.retention.deleteRun(other.id)).toBe(true);
      await stream.until('event: run-deleted');
      expect(stream.frames('run')).toEqual([created, renamed]);
      expect(stream.frames('run-deleted')).toEqual([JSON.stringify({ id: other.id })]);
    } finally { await stream.close(); }
    expect(held()).toEqual([0, 0, 0]);
  });
  it('rejects canonical duplicates on the streaming route too', async () => {
    const response = await apiRequest(app, '/api/v1/workspace/run-events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: ['default', 'boot'].map(projectId => ({ projectId, runId, afterSeq: 0 })) }),
    });
    expect(response.status).toBe(400);
  });
  it('exposes finite checkout recovery with validated identifiers', async () => {
    const response = await apiRequest(app, '/api/v1/projects/checkout/co-fixture/progress');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ progress: null });
    expect((await apiRequest(app, '/api/v1/p/boot/projects/checkout/co-fixture/progress')).status).toBe(404);
  });
});


it('resets an individually oversized wire envelope instead of replaying it forever', async () => {
  store.eventLog.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT - 100) });
  const finite = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).json());
  expect(finite.results[0]!.type).toBe('batch');
  const controller = new AbortController();
  const response = await apiRequest(app, '/api/v1/workspace/run-events', {
    method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs: [{ projectId: 'boot', runId, afterSeq: 0 }] }),
  });
  const reader = response.body!.getReader();
  let wire = '';
  try {
    while (!wire.includes('"type":"reset"')) {
      const { value, done } = await reader.read();
      if (done) break;
      wire += new TextDecoder().decode(value);
    }
    expect(wire).toContain('"type":"reset"');
    expect(wire).toContain('"status":413');
  } finally { controller.abort(); await reader.cancel(); }
});


it.each([-1, 0, 1])('delivers or resets at the complete SSE wire boundary (%i)', async difference => {
  const shape = { type: 'event', projectId: 'boot', runId, name: 'run-event', event: { type: 'note', text: '', seq: 1, ts: new Date().toISOString() } }
  const overhead = Buffer.byteLength(`event: live\ndata: ${JSON.stringify(shape)}\n\n`)
  store.eventLog.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT + difference - overhead) })
  const controller = new AbortController()
  const response = await apiRequest(app, '/api/v1/workspace/run-events', {
    method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs: [{ projectId: 'boot', runId, afterSeq: 0 }] }),
  })
  const reader = response.body!.getReader()
  let wire = ''
  try {
    while (!wire.includes('"type":"event"') && !wire.includes('"type":"reset"')) {
      const { value, done } = await reader.read()
      if (done) break
      wire += new TextDecoder().decode(value)
    }
    if (difference > 0) expect(wire).toContain('"status":413')
    else {
      const block = wire.split('\n\n').find(frame => frame.includes('"type":"event"'))!
      expect(block).toBeDefined()
      expect(Buffer.byteLength(block + '\n\n')).toBe(LIVE_BYTE_LIMIT + difference)
    }
  } finally { controller.abort(); await reader.cancel() }
})

it('sends an explicit snapshot frame for active content behind the SSE cursor', async () => {
  store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
  store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'live text' });
  store.eventLog.appendEvent(runId, { type: 'note', text: 'later persisted event' });
  const controller = new AbortController();
  const response = await apiRequest(app, '/api/v1/workspace/run-events', {
    method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs: [{ projectId: 'boot', runId, afterSeq: 3 }] }),
  });
  const reader = response.body!.getReader();
  let wire = '';
  try {
    while (!wire.includes('"type":"snapshot"')) {
      const next = await reader.read();
      if (next.done) throw new Error('stream ended before snapshot');
      wire += new TextDecoder().decode(next.value);
    }
    const data = wire.split('\n').find(line => line.startsWith('data: ') && line.includes('"type":"snapshot"'))!;
    expect(JSON.parse(data.slice(6))).toMatchObject({ type: 'snapshot', projectId: 'boot', runId, name: 'ui-event',
      event: { seq: 2, type: 'item.updated', item: { text: 'live text' } } });
  } finally { controller.abort(); await reader.cancel(); }
});
