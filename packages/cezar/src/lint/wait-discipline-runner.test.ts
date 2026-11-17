import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baselines, scanSuite, type Baseline } from './server-wait-baseline.ts';
import { compareToBaseline, readBaseline, tally } from './wait-baseline.ts';
import { serverWaitProblems, unitWaitProblems } from './wait-discipline-runner.ts';
import { scannedServerFile } from './test-wait-discipline.ts';
import { scannedUnitFile, scanTree } from './unit-wait-discipline.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wait-lint-'));
  roots.push(root);
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'core/harness-parity.testkit.ts'), '');
  // The old repository scope check requires more than 300 files, including the harness.
  for (let i = 0; i < 300; i++) writeFileSync(join(root, `empty-${i}.test.ts`), '');
  const lists: Baseline[] = baselines.map((baseline, i) => ({ ...baseline, path: join(root, `${i}.baseline.json`) }));
  for (const baseline of lists) writeFileSync(baseline.path, JSON.stringify({ sites: [] }));
  return { root, lists };
}

const entry = { file: 'a.test.ts', rule: 'sleep', site: 'await sleep(5)', count: 1 };

describe('wait discipline runner guarantees on synthetic trees', () => {
  it('keeps each traversal scope, with the server fixture and excluded directories omitted', () => {
    expect(scannedServerFile('packages/cezar/src/core/a.testkit.ts')).toBe(true);
    for (const file of ['test-wait-discipline.test.ts', 'test-wait-discipline.testkit.ts', '__fixtures__/a.test.ts', 'node_modules/a.test.ts', 'core/helper.ts']) {
      expect(scannedServerFile(`packages/cezar/src/${file}`)).toBe(false);
    }
    expect(scannedUnitFile('packages/web/src/routes/a.test.tsx')).toBe(true);
    expect(scannedUnitFile('packages/web/src/test/a.test.ts')).toBe(true);
    expect(scannedUnitFile('packages/web/src/node_modules/a.test.ts')).toBe(false);
    expect(scannedUnitFile('packages/web/e2e/a.test.ts')).toBe(false);
    const { root, lists } = fixture();
    mkdirSync(join(root, '__fixtures__'));
    mkdirSync(join(root, 'node_modules'));
    for (const file of ['test-wait-discipline.test.ts', '__fixtures__/a.test.ts', 'node_modules/a.test.ts']) {
      writeFileSync(join(root, file), 'const broken = "never closed');
    }
    expect(serverWaitProblems(false, root, lists)).toEqual([]);
    rmSync(join(root, 'core/harness-parity.testkit.ts'));
    expect(serverWaitProblems(false, root, lists)).toEqual([expect.stringContaining('scan scope changed')]);
  });

  it.each([0, 1])('reports stale server baseline %i and only lowers it in update mode', index => {
    const { root, lists } = fixture();
    const rule = index === 0 ? 'sleep' : 'poll-deadline';
    writeFileSync(lists[index]!.path, JSON.stringify({ sites: [{ ...entry, rule }] }));
    expect(serverWaitProblems(false, root, lists)).toEqual([
      expect.stringMatching(/baseline\.json:1:1 cez\/test-wait-discipline: stale entry .+TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint/),
    ]);
    writeFileSync(join(root, 'new.test.ts'), 'await sleep(5);\nwhile (!ready) await sleep(5);');
    expect(serverWaitProblems(true, root, lists)).toEqual([]);
    expect(JSON.parse(readFileSync(lists[index]!.path, 'utf8')).sites).toEqual([]);
  });

  it('reads only the files a baseline names, and gives the verdict a scan of the whole suite gives', () => {
    const { root, lists } = fixture();
    writeFileSync(join(root, 'a.test.ts'), 'await sleep(5);\nawait sleep(5);\n');
    writeFileSync(join(root, 'b.test.ts'), 'await delay(5);\n');
    const sleep = (file: string, site: string, count: number) => ({ file, rule: 'sleep', site, count });
    writeFileSync(lists[0]!.path, JSON.stringify({ sites: [sleep('a.test.ts', 'await sleep(5);', 3), sleep('b.test.ts', 'await delay(5);', 1), sleep('gone.test.ts', 'await pause(5);', 1)] }));
    const whole = compareToBaseline(tally(scanSuite(root).filter(site => lists[0]!.rules.includes(site.rule))), readBaseline(lists[0]!.path)).stale;
    expect(whole.map(entry => entry.file)).toEqual(['a.test.ts', 'gone.test.ts']);
    expect(serverWaitProblems(false, root, lists)).toEqual(whole.map(entry => expect.stringContaining(`stale entry ${entry.file} [${entry.rule}] ×${entry.count}`)));
    expect(serverWaitProblems(true, root, lists)).toEqual([]);
    expect(readBaseline(lists[0]!.path)).toEqual([sleep('a.test.ts', 'await sleep(5);', 2), sleep('b.test.ts', 'await delay(5);', 1)]);
  });

  it('writes a missing baseline once from the whole suite', () => {
    const { root, lists } = fixture();
    writeFileSync(join(root, 'a.test.ts'), 'await sleep(5);\n');
    writeFileSync(join(root, 'b.test.ts'), 'while (!ready()) await sleep(5);\n');
    for (const baseline of lists) rmSync(baseline.path);
    expect(serverWaitProblems(true, root, lists)).toEqual([]);
    expect(readBaseline(lists[0]!.path)).toEqual([{ file: 'a.test.ts', rule: 'sleep', site: 'await sleep(5);', count: 1 }]);
    expect(readBaseline(lists[1]!.path)).toEqual([{ file: 'b.test.ts', rule: 'poll-deadline', site: 'while (!ready()) await sleep(5);', count: 1 }]);
    const { root: cockpit } = fixture();
    mkdirSync(join(cockpit, 'routes'));
    writeFileSync(join(cockpit, 'routes/a.test.tsx'), 'await sleep(5)\n');
    const path = join(cockpit, 'unit.baseline.json');
    expect(unitWaitProblems(true, cockpit, path)).toEqual([]);
    expect(readBaseline(path)).toEqual(tally(scanTree(cockpit)));
    expect(readBaseline(path)).toEqual([{ file: 'routes/a.test.tsx', rule: 'sleep', site: 'await sleep(5)', count: 1 }]);
  });

  it('reports a stale cockpit entry and only lowers it in update mode', () => {
    const { root } = fixture();
    const path = join(root, 'unit.baseline.json');
    writeFileSync(path, JSON.stringify({ sites: [entry] }));
    expect(unitWaitProblems(false, root, path)).toEqual([
      expect.stringMatching(/unit\.baseline\.json:1:1 cez\/unit-wait-discipline: stale entry .+UNIT_WAIT_DISCIPLINE_UPDATE=1 npm run lint/),
    ]);
    writeFileSync(join(root, 'new.test.ts'), 'await sleep(5);');
    expect(unitWaitProblems(true, root, path)).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8')).sites).toEqual([]);
  });
});
