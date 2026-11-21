import { describe, expect, it, vi } from 'vitest';
import type { BackendCheck } from '../core/backend-detect.ts';
import { BACKEND_MAX_AGE_MS, BACKEND_RECHECK_MS, createBackendChecks } from './backend-checks.ts';

const row = (version: string): BackendCheck[] => [{ name: 'git', available: true, version }];

function fixture() {
  let time = 1_000;
  let stamp = 'a';
  const detect = vi.fn(async () => row(stamp));
  const stampReader = vi.fn(async () => stamp);
  const onChange = vi.fn();
  const checks = createBackendChecks({ detect, stamp: stampReader, onChange, now: () => time });
  /** Lets a started detection settle: it resolves on the microtask queue. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    checks, detect, stampReader, onChange, settle,
    advance: (ms: number) => { time += ms; },
    setStamp: (next: string) => { stamp = next; },
  };
}

describe('createBackendChecks', () => {
  it('starts detection on a cold read without waiting for it', async () => {
    const f = fixture();
    let finish!: (checks: BackendCheck[]) => void;
    f.detect.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    expect(await f.checks.read()).toEqual([]);
    expect(f.detect).toHaveBeenCalledOnce();
    finish(row('1'));
    await f.settle();
    expect(await f.checks.read()).toEqual(row('1'));
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith(row('1'));
  });

  it('detects no more while the stamp holds, and reads the stamp at most once per window', async () => {
    const f = fixture();
    await f.checks.read();
    await f.settle();
    f.stampReader.mockClear();
    await f.checks.read();
    expect(f.stampReader).not.toHaveBeenCalled();
    for (let tick = 0; tick < 10; tick++) {
      f.advance(BACKEND_RECHECK_MS);
      await f.checks.read();
    }
    expect(f.stampReader).toHaveBeenCalledTimes(10);
    expect(f.detect).toHaveBeenCalledOnce();
  });

  it('detects again on the first read after the stamp changes', async () => {
    const f = fixture();
    await f.checks.read();
    await f.settle();
    f.setStamp('b');
    f.advance(BACKEND_RECHECK_MS);
    await f.checks.read();
    await f.settle();
    expect(f.detect).toHaveBeenCalledTimes(2);
    expect(await f.checks.read()).toEqual(row('b'));
    expect(f.onChange).toHaveBeenLastCalledWith(row('b'));
  });

  it('keeps the stamp read before detection, so a change during detection is seen next time', async () => {
    const f = fixture();
    let finish!: (checks: BackendCheck[]) => void;
    f.detect.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await f.checks.read();
    f.setStamp('b');
    finish(row('a'));
    await f.settle();
    f.advance(BACKEND_RECHECK_MS);
    await f.checks.read();
    expect(f.detect).toHaveBeenCalledTimes(2);
  });

  it('finishes reading the stamp before it starts detection', async () => {
    const f = fixture();
    let release!: (stamp: string) => void;
    f.stampReader.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const read = f.checks.read();
    await f.settle();
    expect(f.detect).not.toHaveBeenCalled();
    release('a');
    await read;
    expect(f.detect).toHaveBeenCalledOnce();
  });

  it('retries after a failed detection and keeps the last checks meanwhile', async () => {
    const f = fixture();
    await f.checks.read();
    await f.settle();
    f.setStamp('b');
    f.detect.mockRejectedValueOnce(new Error('spawn failed'));
    f.advance(BACKEND_RECHECK_MS);
    await f.checks.read();
    await f.settle();
    expect(await f.checks.read()).toEqual(row('a'));
    f.advance(BACKEND_RECHECK_MS);
    await f.checks.read();
    await f.settle();
    expect(f.detect).toHaveBeenCalledTimes(3);
    expect(await f.checks.read()).toEqual(row('b'));
  });

  it('detects again once the result reaches the age ceiling, even with an unchanged stamp', async () => {
    const f = fixture();
    await f.checks.read();
    await f.settle();
    f.advance(BACKEND_MAX_AGE_MS - 1);
    await f.checks.read();
    expect(f.detect).toHaveBeenCalledOnce();
    f.advance(1);
    f.advance(BACKEND_RECHECK_MS);
    await f.checks.read();
    expect(f.detect).toHaveBeenCalledTimes(2);
  });

  it('starts no second detection or stamp read while one detection is pending', async () => {
    const f = fixture();
    f.detect.mockReturnValueOnce(new Promise(() => {}));
    await f.checks.read();
    f.advance(BACKEND_RECHECK_MS * 3);
    await f.checks.read();
    await f.checks.read();
    expect(f.detect).toHaveBeenCalledOnce();
    expect(f.stampReader).toHaveBeenCalledOnce();
  });
});
