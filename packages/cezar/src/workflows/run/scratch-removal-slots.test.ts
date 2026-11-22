import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autosaveDeletionGate } from '../../autosave-removal-slots.ts';
import { jobsDeletionGate } from '../../jobs/removal-slot.ts';
import { runDataDir } from '../../project-paths.ts';
import { agentShortTmpDir, agentTmpDir, agentTmpDirLocations, agentTmpDirMayExist, agentTmpEnv, sweepAgentTmpDirs } from '../../runs/agent-tmpdir.ts';
import type { DeletionKind } from '../../runs/removal-slots.ts';
import { sealTestRunSlots } from '../../runs/removal-slots.testkit.ts';
import { setRunStatus } from '../../runs/run-store.testkit.ts';
import { RunStore } from '../../runs/store.ts';
import { unused } from '../unused.testkit.ts';
import { RunSettlement } from './run-settlement.ts';

// The two scratch paths ask the removal slots for `scratch` (spec 2026-11-21-run-lifecycle-and-store-ports,
// "Removal cases"): a gate that refuses keeps the scratch. This file's gate refuses the runs a case names.
const asked: string[] = [];
const refused = new Set<string>();
sealTestRunSlots({ gates: [{ name: 'test scratch gate', refuse: (runId, kind) => {
  asked.push(`${runId}:${kind}`);
  return refused.has(runId) ? 'the test keeps this scratch' : undefined;
} }] });

let root: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-scratch-slots-'));
  dataDir = join(root, '.ai/cezar');
  asked.length = 0;
  refused.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the terminal scratch reap', () => {
  let store: RunStore;
  beforeEach(() => { store = RunStore.open(dataDir); });
  afterEach(() => store.close());

  /** A settlement whose reads all let a finished plain run's scratch go. */
  function settlement(): RunSettlement {
    type Args = ConstructorParameters<typeof RunSettlement>;
    return new RunSettlement(unused<Args[0]>('context', { store, dataDir }), unused<Args[1]>('humanWaits'),
      unused<Args[2]>('workerQuestions'), unused<Args[3]>('autosave'),
      unused<Args[4]>('line', { hasStarting: () => false, hasQueued: () => false }), unused<Args[5]>('resume'),
      unused<Args[6]>('workers'), unused<Args[7]>('completionGate'),
      unused<Args[8]>('host', { active: new Map(), hasClaim: () => false, autosaveCleanupBlocker: () => undefined }), '', '');
  }

  function endedRun(): string {
    const run = store.createRun({ title: 'ended', task: 'ended', workflow: 'quick-task', steps: [] });
    setRunStatus(store, run.id, RUN_STATUS.done);
    agentTmpEnv(dataDir, run.id, {});
    return run.id;
  }

  it('keeps the scratch when a gate refuses it', () => {
    const id = endedRun();
    refused.add(id);
    settlement().reapTerminalScratch(id);
    expect(asked).toEqual([`${id}:scratch`]);
    expect(agentTmpDirMayExist(dataDir, id)).toBe(true);
  });

  it('removes the scratch when no gate refuses it', () => {
    const id = endedRun();
    settlement().reapTerminalScratch(id);
    expect(asked).toEqual([`${id}:scratch`]);
    expect(agentTmpDirMayExist(dataDir, id)).toBe(false);
  });
});

describe('the startup orphan sweep', () => {
  it('keeps an orphan whose scratch a gate refuses and sweeps the other', () => {
    const [kept, swept] = [randomUUID(), randomUUID()];
    for (const id of [kept, swept]) agentTmpEnv(dataDir, id, {});
    refused.add(kept);

    sweepAgentTmpDirs(dataDir, []);

    expect(asked).toEqual(expect.arrayContaining([`${kept}:scratch`, `${swept}:scratch`]));
    expect([agentTmpDirMayExist(dataDir, kept), agentTmpDirMayExist(dataDir, swept)]).toEqual([true, false]);
  });

  /** A short directory `t/<id8>` whose marker names the run, as `agentTmpEnv` mints it. */
  function shortDir(id: string): string {
    const dir = agentShortTmpDir(dataDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.cez-run'), id);
    return dir;
  }

  it('asks for a short directory with no control directory, and keeps the refused one', () => {
    const [kept, swept] = [randomUUID(), randomUUID()];
    const [keptDir, sweptDir] = [shortDir(kept), shortDir(swept)];
    refused.add(kept);

    sweepAgentTmpDirs(dataDir, []);

    expect(asked).toEqual(expect.arrayContaining([`${kept}:scratch`, `${swept}:scratch`]));
    expect([existsSync(keptDir), existsSync(sweptDir)]).toEqual([true, false]);
  });

  it('keeps the short directory of a run refused for its control directory', () => {
    const id = randomUUID();
    mkdirSync(agentTmpDir(dataDir, id), { recursive: true });
    const short = shortDir(id);
    refused.add(id);

    sweepAgentTmpDirs(dataDir, []);

    expect(asked).toEqual([`${id}:scratch`]);
    expect([existsSync(agentTmpDir(dataDir, id)), existsSync(short)]).toEqual([true, true]);
  });

  it('keeps a refused run\'s markerless short directory whichever control directory the sweep reaches first', () => {
    // Two runs share the short name; the refused one's scratch is there without its marker yet.
    const allowed = 'aaaaaaaa-1111-4222-8333-444455556666', kept = 'aaaaaaaa-9999-4222-8333-444455556666';
    for (const id of [allowed, kept]) mkdirSync(agentTmpDir(dataDir, id), { recursive: true });
    const short = agentShortTmpDir(dataDir, kept);
    expect(short).toBe(agentShortTmpDir(dataDir, allowed));
    mkdirSync(short, { recursive: true });
    writeFileSync(join(short, 'note.txt'), 'scratch of the refused run');
    refused.add(kept);

    sweepAgentTmpDirs(dataDir, []);

    expect(asked).toEqual(expect.arrayContaining([`${allowed}:scratch`, `${kept}:scratch`]));
    expect([existsSync(agentTmpDir(dataDir, allowed)), existsSync(agentTmpDir(dataDir, kept)), existsSync(short)]).toEqual([false, true, true]);
  });

  it('keeps the fallback directory in the OS temp root of a refused run', () => {
    // A dataDir so deep that the run's scratch falls back to a digest directory in the OS temp root.
    const deep = join(realpathSync(tmpdir()), `cez-deep-slots-${'d'.repeat(80)}`);
    const deepDataDir = join(deep, 'repo', '.ai', 'cezar');
    const id = randomUUID();
    const fallback = agentTmpEnv(deepDataDir, id, {}).TMPDIR!;
    try {
      expect(fallback.startsWith(deep)).toBe(false);
      refused.add(id);

      sweepAgentTmpDirs(deepDataDir, []);

      expect(asked).toEqual([`${id}:scratch`]);
      expect(existsSync(fallback)).toBe(true);
    } finally {
      rmSync(fallback, { recursive: true, force: true });
      rmSync(deep, { recursive: true, force: true });
    }
  });
});

describe('the startup orphan sweep of a moved project', () => {
  it('keeps the fallback directory of a refused task the move left in .ai/cezar', () => {
    // A project so deep that the task's scratch falls back to a digest directory in the OS temp root.
    const deep = join(realpathSync(tmpdir()), `cez-deep-moved-${randomUUID().slice(0, 8)}-${'d'.repeat(72)}`);
    const moved = join(deep, 'repo', '.ai', 'squawk');
    const [kept, swept] = [randomUUID(), randomUUID()];
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'legacy-runs.json'), JSON.stringify({ version: 1, runs: [kept, swept] }));
    const keptFallback = agentTmpEnv(moved, kept, {}).TMPDIR!, sweptFallback = agentTmpEnv(moved, swept, {}).TMPDIR!;
    try {
      expect(keptFallback.startsWith(deep)).toBe(false);
      refused.add(kept);

      sweepAgentTmpDirs(moved, []);

      expect(asked).toEqual(expect.arrayContaining([`${kept}:scratch`, `${swept}:scratch`]));
      expect([existsSync(keptFallback), existsSync(sweptFallback)]).toEqual([true, false]);
    } finally {
      for (const dir of [keptFallback, sweptFallback]) rmSync(dir, { recursive: true, force: true });
      rmSync(deep, { recursive: true, force: true });
    }
  });
});

describe('the built-in gates for scratch', () => {
  const kinds: DeletionKind[] = ['history', 'worktree', 'archive-tmp', 'scratch'];

  it('the jobs gate keeps scratch and an archived member tmp directory while a job runs in it', () => {
    const id = randomUUID();
    agentTmpEnv(dataDir, id, {});
    // A record that cannot be read may belong to a supervisor that still runs (`jobRunsIn`).
    writeFileSync(join(agentTmpDirLocations(dataDir, id)[0]!, 'bench.job.db'), 'damaged');
    expect(kinds.map(kind => jobsDeletionGate.refuse(id, kind, dataDir) !== undefined)).toEqual([false, false, true, true]);
  });

  it('the autosave gate keeps scratch, history and the worktree while its cleanup evidence cannot be read', () => {
    const id = randomUUID();
    const runs = join(runDataDir(dataDir, id), 'runs');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, `${id}.autosave-cleanup.json`), 'not json');
    expect(kinds.map(kind => autosaveDeletionGate.refuse(id, kind, dataDir) !== undefined)).toEqual([true, true, false, true]);
  });
});
