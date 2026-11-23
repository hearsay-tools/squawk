import { describe, expect, it } from 'vitest';
import { scanFiles } from './test-wait-discipline.ts';
import { compareToBaseline, tally } from './wait-baseline.ts';

const snippets = [
  `async function test() {
    service.armDestroyRetries();
    await vi.waitFor(() => expect(store.getRun(id).retry.attempts).toBe(2), { timeout: 30_000 });
    const snapshot = store.getRun(id);
    expect(snapshot.destroy.error).toBe('busy');
  }`,
  `async function test() {
    service.armDestroyRetries();
    await vi.waitFor(() => expect(store.getRun(id).retry.attempts).toBe(2), { timeout: 30_000 });
    await vi.waitFor(() => expect(store.getRun(id).destroy.error).toBe('busy'), { timeout: 30_000 });
  }`,
  `async function test() {
    await vi.waitFor(() => expect(ready).toBe(true), { timeout: 30_000 });
    await writerDone;
    const snapshot = store.getRun(id);
  }`,
  `async function test() {
    setInterval(writeState, 20);
    await waitFor(() => ready, 30_000);
    expect(readFileSync(path, 'utf8')).toBe('done');
  }`,
  `async function test() {
    setInterval(writeState, 20);
    await waitFor(() => ready, 30_000);
    // bound: the writer is held by the fixture's explicit gate here.
    const snapshot = store.getRun(id);
  }`,
  `async function test() {
    setInterval(writeState, 20);
    await waitFor(() => ready, 30_000);
    const readLater = () => store.getRun(id);
  }`,
  `async function test() {
    let state = 'busy';
    setTimeout(() => { state = 'done'; }, 20);
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 30_000 });
    expect(state).toBe('done');
  }`,
  `async function test() {
    watch(path, update);
    await waitFor(() => ready, 30_000);
    expect(readFileSync(path, 'utf8')).toBe('done');
  }`,
  `async function test() {
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 30_000 });
    const snapshot = store.getRun(id);
  }`,
];

describe('server snapshots after a condition wait', () => {
  it('flags a second observation and accepts retrying the read or waiting for writer completion', () => {
    const sites = scanFiles(snippets.map((code, i) => ({ file: `gap-${i}.test.ts`, code })));
    expect(sites.map(each => each.map(site => site.rule))).toEqual([
      ['one-shot-read'], [], [], ['one-shot-read'], [], [], ['one-shot-read'], ['one-shot-read'], [],
    ]);
    expect(sites[0]?.[0]).toMatchObject({ line: 4, site: 'const snapshot = store.getRun(id);' });
    const chained = scanFiles([{
      file: 'poll.test.ts',
      code: `async function test() { service.start(); await expect.poll(() => ready, { timeout: 30_000 }).toBe(true); expect(store.getRun(id)).toBeDefined(); }`,
    }]);
    expect(chained[0]?.map(site => site.rule)).toEqual(['one-shot-read']);
    // A new file cannot borrow an inherited site's allowance.
    const inherited = tally(sites[0] ?? []);
    const newSite = (sites[0] ?? []).map(site => ({ ...site, file: 'new.test.ts' }));
    expect(compareToBaseline(tally(newSite), inherited).added).toHaveLength(1);
  });
});
