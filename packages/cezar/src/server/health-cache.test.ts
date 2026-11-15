import { expect, it, vi } from 'vitest';
import { createHealthCache, HEALTH_MAX_STALE_MS, HEALTH_TTL_MS } from './health-cache.ts';

type Payload = { repo: number; checks: string[] };

function setup() {
  let clock = 0;
  let repo = 0;
  const releases: Array<() => void> = [];
  const snapshot = vi.fn(() => new Promise<Payload>((resolve) => {
    repo++;
    const value = { repo, checks: [] };
    releases.push(() => resolve(value));
  }));
  const publish = vi.fn<(payload: Payload) => void>();
  const cache = createHealthCache<Payload>({ snapshot, publish, now: () => clock });
  // Settles the oldest pending snapshot once the cache has started one (a few microtasks at most).
  const release = async () => {
    for (let turn = 0; releases.length === 0; turn++) {
      if (turn > 100) throw new Error('no snapshot started');
      await Promise.resolve();
    }
    releases.shift()!();
  };
  return { cache, snapshot, publish, release, advance: (ms: number) => { clock += ms; } };
}

it('dedupes concurrent refreshes and publishes only a changed payload', async () => {
  const { cache, snapshot, publish, release } = setup();
  const first = cache.refresh();
  expect(cache.refresh()).toBe(first);
  await release();
  expect(await first).toEqual({ repo: 1, checks: [] });
  expect(snapshot).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledOnce();
});

it('serves a fresh cache, revalidates a stale one behind the read, and awaits one past the ceiling', async () => {
  const { cache, snapshot, release, advance } = setup();
  const cold = cache.read();
  await release();
  expect(await cold).toMatchObject({ repo: 1 });
  expect(await cache.read()).toMatchObject({ repo: 1 });
  expect(snapshot).toHaveBeenCalledOnce();
  advance(HEALTH_TTL_MS + 1);
  expect(await cache.read()).toMatchObject({ repo: 1 });
  expect(snapshot).toHaveBeenCalledTimes(2);
  await release();
  advance(HEALTH_MAX_STALE_MS + 1);
  const waited = cache.read();
  await release();
  expect(await waited).toMatchObject({ repo: 3 });
});

// hearsay-tools/squawk#3355: a patch must not take a new snapshot, whose Git reads spawn processes.
it('patches the cached payload without a snapshot and keeps its age', async () => {
  const { cache, snapshot, publish, release, advance } = setup();
  const cold = cache.refresh();
  const patched = cache.patch((payload) => ({ ...payload, checks: ['git'] }));
  await release();
  await cold;
  await patched;
  expect(snapshot).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenLastCalledWith({ repo: 1, checks: ['git'] });
  expect(await cache.read()).toEqual({ repo: 1, checks: ['git'] });
  advance(HEALTH_TTL_MS + 1);
  await cache.read();
  expect(snapshot).toHaveBeenCalledTimes(2);
});

it('computes a snapshot when a patch finds no cached payload', async () => {
  const { cache, snapshot, release } = setup();
  const patched = cache.patch((payload) => payload);
  await release();
  await patched;
  expect(snapshot).toHaveBeenCalledOnce();
  expect(await cache.read()).toMatchObject({ repo: 1 });
});

it('shapes only a payload served from the cache', async () => {
  const { cache, release } = setup();
  const mark = (payload: Payload) => ({ ...payload, checks: ['served'] });
  const cold = cache.read(mark);
  await release();
  expect(await cold).toEqual({ repo: 1, checks: [] });
  expect(await cache.read(mark)).toEqual({ repo: 1, checks: ['served'] });
});
