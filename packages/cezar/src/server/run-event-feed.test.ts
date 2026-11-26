import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunLifecycle } from '../runs/lifecycle.ts';
import { lifecycleListeners } from '../runs/lifecycle-listeners.testkit.ts';
import { readFiniteRunFeed, readRunEventBatch, subscribeRunFeed } from './run-event-feed.ts';
import { LIVE_BYTE_LIMIT } from '@open-mercato/cezar-contract/live-limits';
import type { RunEvent } from '@open-mercato/cezar-contract';
// Its runs are deleted, reclaimed or archived, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';

let dataDir: string;
let store: RunStore;
let runId: string;
let listeners: ReturnType<typeof lifecycleListeners>;
const signal = () => new AbortController().signal;
const demand = () => ({ projectId: 'boot', runId, afterSeq: 0 });
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-feed-'));
  store = RunStore.open(dataDir);
  listeners = lifecycleListeners(store.lifecycle);
  runId = store.createRun({ title: 'Feed', task: 'Feed', workflow: 'quick-task', steps: [] }).id;
});
afterEach(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });

describe('bounded persisted feed', () => {
  it('reads compressed history with an accepted-prefix cursor', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ seq: i + 1, type: 'note', ts: '', text: 'archive' })).join('\n') + '\n';
    writeFileSync(join(dataDir, 'runs', `${runId}.ndjson.br`), brotliCompressSync(lines));
    const a = await readRunEventBatch(dataDir, demand(), signal());
    expect(a.events).toHaveLength(256);
    const b = await readRunEventBatch(dataDir, { ...demand(), cursor: a.cursor, afterSeq: a.afterSeq }, signal());
    expect(b.events).toHaveLength(44);
    expect(b.hasMore).toBe(false);
  });
  it('leaves a partial trailing record for the next read', async () => {
    const path = join(dataDir, 'runs', `${runId}.ndjson`);
    const line = JSON.stringify({ seq: 1, type: 'note', ts: '', text: 'complete' });
    writeFileSync(path, line);
    const a = await readRunEventBatch(dataDir, demand(), signal());
    expect(a.events).toEqual([]);
    expect(a.hasMore).toBe(false);
    writeFileSync(path, line + '\n');
    const b = await readRunEventBatch(dataDir, { ...demand(), cursor: a.cursor }, signal());
    expect(b.events[0]?.seq).toBe(1);
  });
  it('requests rehydration for an oversized event rather than looping without progress', async () => {
    store.eventLog.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT + 1) });
    await expect(readRunEventBatch(dataDir, demand(), signal())).rejects.toMatchObject({ status: 413 });
  });
  it('resumes both snapshot and disk prefixes across byte-limited pages', async () => {
    store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'item', text: '' } });
    store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'item', field: 'text', delta: 'latest text' });
    store.eventLog.appendEvent(runId, { type: 'note', text: 'following' });
    const snapshots = store.liveReadSnapshot(runId);
    let cursor: string | undefined;
    let afterSeq = 0;
    const seen: RunEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await readRunEventBatch(dataDir, { ...demand(), cursor, afterSeq }, signal(), 150, snapshots);
      seen.push(...page.events);
      cursor = page.cursor; afterSeq = page.afterSeq;
      expect(page.events).toHaveLength(1);
      expect(page.hasMore).toBe(i < 2);
    }
    expect(seen.map(event => event.seq)).toEqual([1, 2, 3]);
    expect(seen[1]).toMatchObject({ type: 'item.updated', item: { text: 'latest text' } });
  });
  it('cancels a snapshot-only response while checking for absent disk history', async () => {
    const controller = new AbortController();
    const reading = readRunEventBatch(dataDir, demand(), controller.signal, LIVE_BYTE_LIMIT,
      { throughSeq: 1, events: [{ type: 'item.updated', seq: 1, ts: '', item: { id: 'item', kind: 'message', text: 'live' } }] });
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('releases the finite scan write observer on cancellation and a failed read', async () => {
    const before = listeners('run.event');
    const controller = new AbortController();
    const reading = readFiniteRunFeed({ store, dataDir }, demand(), controller.signal);
    expect(listeners('run.event')).toBe(before + 1);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(listeners('run.event')).toBe(before);
    store.eventLog.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT + 1) });
    await expect(readFiniteRunFeed({ store, dataDir }, demand(), signal())).rejects.toMatchObject({ status: 413 });
    expect(listeners('run.event')).toBe(before);
  });
  it('rejects expired cursors and pre-aborted requests', async () => {
    store.eventLog.appendEvent(runId, { type: 'note', text: 'old' });
    const a = await readRunEventBatch(dataDir, demand(), signal());
    writeFileSync(join(dataDir, 'runs', `${runId}.ndjson`), '');
    await expect(readRunEventBatch(dataDir, { ...demand(), cursor: a.cursor }, signal())).rejects.toMatchObject({ status: 409 });
    const controller = new AbortController(); controller.abort();
    await expect(readRunEventBatch(dataDir, demand(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ordered replay/live handoff', () => {
  it('attaches before replay, deduplicates overlap, and releases every listener on abort', async () => {
    store.eventLog.appendEvent(runId, { type: 'note', text: 'persisted' });
    const controller = new AbortController();
    const seen: number[] = [];
    let sawLive!: () => void;
    const received = new Promise<void>(resolve => { sawLive = resolve; });
    const baseline = listeners('run.event');
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      async event(event) {
        seen.push(event.seq);
        if (event.seq === 1) store.eventLog.appendEvent(runId, { type: 'note', text: 'during replay' });
        if (event.seq === 3) sawLive();
      }, reset: () => { throw new Error('unexpected reset'); },
    }, controller.signal);
    expect(listeners('run.event')).toBe(baseline + 1);
    store.eventLog.appendEvent(runId, { type: 'note', text: 'during read' });
    await received;
    controller.abort(); await task;
    expect(seen).toEqual([1, 2, 3]);
    expect(listeners('run.event')).toBe(baseline);
    expect([listeners('run.deleted'), listeners('store.closed')]).toEqual([0, 0]);
  });
  it('measures live events once and drains bursts across queue compaction', async () => {
    store.eventLog.appendEvent(runId, { type: 'note', text: 'start' });
    const controller = new AbortController();
    const seen: number[] = [];
    let measured = 0;
    let received!: () => void;
    const drained = new Promise<void>(resolve => { received = resolve; });
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      async event(event) {
        seen.push(event.seq);
        if (event.seq === 1 || event.seq === 131) {
          for (let seq = event.seq + 1; seq <= event.seq + 130; seq++) {
            const next = { seq, ts: '', type: 'note', text: 'burst',
              toJSON() { measured++; return { seq, ts: '', type: 'note', text: 'burst' }; } };
            (store.lifecycle as RunLifecycle).publish('run.event', { runId, event: next });
          }
        }
        if (event.seq === 261) received();
      }, reset: () => { received(); },
    }, controller.signal);
    try { await drained; } finally { controller.abort(); await task; }
    expect(seen).toEqual(Array.from({ length: 261 }, (_, i) => i + 1));
    expect(measured).toBe(260);
  });

  it('bounds a slow live consumer and stops on overflow', async () => {
    const controller = new AbortController();
    let released!: () => void;
    const blocked = new Promise<void>(resolve => { released = resolve; });
    const resets: string[] = [];
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      event: () => blocked, reset: reason => { resets.push(reason); },
    }, controller.signal);
    const event = { seq: 1, ts: '', type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT) } satisfies RunEvent;
    (store.lifecycle as RunLifecycle).publish('run.event', { runId, event });
    released(); await task;
    expect(resets).toHaveLength(1);
    expect(listeners('run.event')).toBe(0);
  });
  it("resets on its own run's delete, not another run's, and releases every listener", async () => {
    const other = store.createRun({ title: 'Other', task: 'Other', workflow: 'quick-task', steps: [] }).id;
    const resets: string[] = [];
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      event: async () => {}, reset: reason => { resets.push(reason); },
    }, signal());
    expect(store.retention.deleteRun(other)).toBe(true);
    expect(resets).toEqual([]);
    expect(store.retention.deleteRun(runId)).toBe(true);
    expect(resets).toEqual(['run removed']);
    expect([listeners('run.event'), listeners('run.deleted'), listeners('store.closed')]).toEqual([0, 0, 0]);
    await task;
  });
  it('detaches replay and live work when the project store closes', async () => {
    const controller = new AbortController();
    const resets: string[] = [];
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      event: async () => {}, reset: reason => { resets.push(reason); },
    }, controller.signal);
    store.close();
    try {
      expect(resets).toEqual(['project removed']);
      expect(listeners('run.event')).toBe(0);
      expect([listeners('run.deleted'), listeners('store.closed')]).toEqual([0, 0]);
    } finally { controller.abort(); await task; }
  });

});

describe('active item replay', () => {
  function activeItem() {
    store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'before' });
    store.eventLog.appendEvent(runId, { type: 'note', text: 'persisted after delta' });
  }
  it('returns snapshots behind the finite cursor without advancing it', async () => {
    activeItem();
    const batch = await readFiniteRunFeed({ store, dataDir }, { ...demand(), afterSeq: 3 }, signal());
    expect(batch).toMatchObject({ events: [], afterSeq: 3, snapshots: [{ seq: 2, type: 'item.updated', item: { text: 'before' } }] });
  });
  it.each([0, 3])('replays active content at afterSeq %i and drains writes beyond the fence', async afterSeq => {
    activeItem();
    const controller = new AbortController();
    const seen: number[] = [];
    const snapshots: RunEvent[] = [];
    let complete!: () => void;
    const received = new Promise<void>(resolve => { complete = resolve; });
    const capture = store.liveReadSnapshot.bind(store);
    const context = { dataDir, store: Object.create(store) as RunStore };
    context.store.liveReadSnapshot = id => {
      const snapshot = capture(id);
      // Append after capture but before the scanner resumes filesystem IO.
      queueMicrotask(() => {
        store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: ' after' });
        store.eventLog.appendEvent(runId, { type: 'item.completed', item: { kind: 'message', id: 'typing', text: 'before after' } });
      });
      return snapshot;
    };
    const task = subscribeRunFeed(context, { ...demand(), afterSeq }, {
      snapshot: async event => { snapshots.push(event); },
      event: async event => { seen.push(event.seq); if (event.seq === 5) complete(); },
      reset: reason => { throw new Error(reason); },
    }, controller.signal);
    try {
      await received;
      expect(seen).toEqual(afterSeq === 0 ? [1, 2, 3, 4, 5] : [4, 5]);
      expect(snapshots.map(event => event.seq)).toEqual(afterSeq === 0 ? [] : [2]);
    } finally { controller.abort(); await task; }
  });
});

it.each([0, 5])('paginates unfiltered large finite snapshots at afterSeq %i', async initialAfterSeq => {
  for (const id of ['a', 'b']) {
    store.eventLog.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id, text: '' } });
    store.eventLog.emitEphemeral(runId, { type: 'item.delta', itemId: id, field: 'text', delta: id.repeat(600 * 1024) });
  }
  store.eventLog.appendEvent(runId, { type: 'note', text: 'after both items' });
  let afterSeq = initialAfterSeq;
  let cursor: string | undefined;
  const seen: RunEvent[] = [];
  for (let page = 0; page < 4; page++) {
    const batch = await readFiniteRunFeed({ store, dataDir }, { ...demand(), afterSeq, cursor }, signal());
    seen.push(...(batch.snapshots ?? []), ...batch.events);
    cursor = batch.cursor;
    afterSeq = batch.afterSeq;
    if (!batch.hasMore) break;
    expect(page).toBeLessThan(3);
  }
  expect(seen.filter(event => event.type === 'item.updated').map(event => event.seq)).toEqual([2, 4]);
  expect(afterSeq).toBe(5);
});
