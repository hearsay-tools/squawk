import { describe, expect, it } from 'vitest';
import { scanSource as serverScan } from './test-wait-discipline.ts';
import { scanSource as unitScan } from './unit-wait-discipline.ts';

for (const [name, scan, floor] of [['server', serverScan, 10_000], ['cockpit', unitScan, 3_000]] as const) {
  const rules = (code: string) => scan('bounds.test.ts', code).map(site => site.rule);
  describe(`${name} wait bound gaps`, () => {
    it('requires a reason at the floor, including computed bounds', () => {
      expect(rules(`await vi.waitFor(check, { timeout: ${floor} })`)).toEqual(['short-bound']);
      expect(rules(`const limit = ${floor / 2} * 2; await expect.poll(check, { timeout: limit }).toBe(true)`)).toEqual(['short-bound']);
      expect(rules(`await vi.waitFor(check, { timeout: ${floor + 1} })`)).toEqual([]);
      expect(rules(`// bound: the fake clock controls this window\nawait vi.waitFor(check, { timeout: ${floor} })`)).toEqual([]);
    });

    it('reads defaults used as wait bounds while leaving required parameters to the caller', () => {
      expect(rules(`async function run(timeout = ${floor}) { await vi.waitFor(check, { timeout }); }`)).toEqual(['short-bound']);
      expect(rules(`const run = async (timeout: number = ${floor}) => { const bound = timeout; await vi.waitFor(check, { timeout: bound }); };`)).toEqual(['short-bound']);
      expect(rules(`async function run(timeout = ${floor + 1}) { await vi.waitFor(check, { timeout }); }`)).toEqual([]);
      expect(rules('async function run(timeout: number) { await vi.waitFor(check, { timeout }); }')).toEqual([]);
      expect(rules(`async function run(timeout = ${floor}) { return timeout; }`)).toEqual([]);
    });

    it('uses the same inclusive floor for poll deadlines and their defaults', () => {
      const loop = (limit: number) => `async function run(limit = ${limit}) { const start = Date.now(); while (Date.now() - start < limit) await sleep(10); }`;
      expect(rules(loop(floor))).toEqual(['poll-deadline']);
      expect(rules(loop(floor + 1))).toEqual([]);
      expect(rules(`const start = Date.now(); while (Date.now() - start < ${floor}) await sleep(10);`)).toEqual(['poll-deadline']);
    });
  });
}
