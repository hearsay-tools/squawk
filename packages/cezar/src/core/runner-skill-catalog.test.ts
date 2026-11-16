import { describe, it, expect, vi } from 'vitest';
import { RunnerSkillCatalog, type SkillCatalogQuery } from './runner-skill-catalog.ts';
const query: SkillCatalogQuery = { runner: 'codex', cwd: '/repo', accountHome: '/account' };
const value = { skills: [{ id: 'one', name: 'one' }], problems: [] };

describe('runner skill cache', () => {
  it('joins concurrent reads and caches by runner, home and folder', async () => {
    const discover = vi.fn(async () => value);
    const catalog = new RunnerSkillCatalog({ adapters: { codex: { discover }, pi: { discover } } });
    const a = catalog.get(query);
    expect(catalog.get(query)).toBe(a);
    expect((await a).source).toBe('live');
    const cached = await catalog.get(query);
    expect(cached.source).toBe('cache');
    cached.skills.length = 0;
    expect((await catalog.get(query)).skills).toHaveLength(1);
    await catalog.get({ ...query, accountHome: '/other' });
    await catalog.get({ ...query, cwd: '/other' });
    await catalog.get({ ...query, runner: 'pi' });
    expect(discover).toHaveBeenCalledTimes(4);
  });
  it('keeps the last good empty list and its problems after failure', async () => {
    const discover = vi.fn().mockResolvedValueOnce({ skills: [], problems: [{ message: 'bad skill' }] }).mockRejectedValue(new Error('secret diagnostics'));
    const catalog = new RunnerSkillCatalog({ adapters: { codex: { discover } } });
    await catalog.get(query);
    catalog.invalidate(query);
    expect(await catalog.get(query)).toMatchObject({ source: 'cache', skills: [], problems: [{ message: 'bad skill' }], reason: expect.stringContaining('unavailable') });
    expect(JSON.stringify(await catalog.get(query))).not.toContain('secret');
  });
  it('bounds an unresponsive adapter and cancels its signal', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const catalog = new RunnerSkillCatalog({ timeoutMs: 100, adapters: { codex: {
        discover: (_, s) => { signal = s; return new Promise(() => {}); },
      } } });
      const pending = catalog.get(query);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ source: 'unavailable', reason: expect.any(String) });
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('does not repopulate an invalidated key from an older pending read', async () => {
    let complete!: (v: typeof value) => void;
    const discover = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValue({ skills: [], problems: [] });
    const catalog = new RunnerSkillCatalog({ adapters: { codex: { discover } } });
    const old = catalog.get(query);
    catalog.invalidate(query);
    await catalog.get(query);
    complete(value);
    await old;
    expect((await catalog.get(query)).skills).toEqual([]);
  });
  it('expires a successful list and reports a missing adapter', async () => {
    let now = 0;
    const discover = vi.fn(async () => value);
    const catalog = new RunnerSkillCatalog({ now: () => now, ttlMs: 10, adapters: { codex: { discover } } });
    await catalog.get(query);
    now = 11;
    expect((await catalog.get(query)).source).toBe('live');
    expect(discover).toHaveBeenCalledTimes(2);
    expect((await catalog.get({ ...query, runner: 'omp' })).source).toBe('unavailable');
  });
});
