import { setSkillProvisionEngineCells, type SkillProvisionEngineCells } from './skill-provision-parity.testkit.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { waitFor } from './harness-parity-core.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';
import { fixedSkillCatalog } from './runner-skill-fixture.testkit.ts';
import { hostSkillCatalogAdapters } from './host-skill-catalog.ts';
import { RunnerSkillCatalog, type SkillCatalogQuery } from './runner-skill-catalog.ts';
import { HARNESS_ADAPTERS } from './harness-parity-core.testkit.ts';
import { plannedWorkflow, skillTaskSteps } from '../workflows/types.ts';

// The skill-provision cells that run a workflow through RunManager. R93 and R94 resolve the
// selected skill above the session and live in skill-provision-parity.testkit.ts.

const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : '';

/** A native gate proves the trigger stays above the seam until the running turn ends. */
async function heldTrigger(runner: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'held-native-trigger-'));
  const wire = join(dir, 'stdin.ndjson');
  const release = join(dir, 'release');
  try {
    await driveRun(runner, 'hold-gated', run => run?.status === 'waiting', 30_000, undefined, {
      env: { CEZ_MOCK_STDIN_FILE: wire, CEZ_MOCK_RELEASE_FILE: release },
      beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog([{ id: 'probe-project', name: 'Probe', path: '/listed/SKILL.md', scope: 'repo' }])),
      during: async ({ store, manager, runId }) => {
        await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'turn.started'));
        expect(manager.sendMessage(runId, [{ type: 'text', text: '/probe-project held arguments' }])).toBe(true);
        expect(store.getRun(runId)?.queuedMessages?.[0]?.text).toBe('/probe-project held arguments');
        expect(read(wire)).not.toContain('probe-project'); // The gate holds the turn; no time-based absence wait.
        writeFileSync(release, 'baseline');
        await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE')));
        expect(read(wire)).toContain('probe-project');
      },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** An engine part file calls this before `describeSkillProvisionParity`. */
export function installSkillProvisionEngine(): void {
  setSkillProvisionEngineCells(ENGINE_CELLS);
}

const ENGINE_CELLS: SkillProvisionEngineCells = {
  openingCommand: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-opening-command-'));
    const wireFile = join(dir, 'wire.ndjson');
    try {
      const result = await driveRun('claude', { prompt: '/compact' }, run => run?.status === 'waiting', 30_000, undefined, {
        env: { CEZ_MOCK_STDIN_FILE: wireFile },
        beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog()),
      });
      const first = JSON.parse(read(wireFile).trim().split('\n')[0]!);
      expect(first.userText).toBe('/compact');
      expect(result.events.some(event => event.type === 'lifecycle' && String(event.message).includes('slash command, which must stay at its start'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  openingSkill: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-opening-skill-'));
    const wireFile = join(dir, 'wire.ndjson');
    try {
      const result = await driveRun('claude', { prompt: '/probe-project typed arguments' }, run => run?.status === 'waiting', 30_000, undefined, {
        env: { CEZ_MOCK_STDIN_FILE: wireFile },
        beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog([{ id: 'probe-project', name: 'Probe', scope: 'repo' }])),
      });
      const first = JSON.parse(read(wireFile).trim().split('\n')[0]!);
      expect(first.blocks.at(-1)).toEqual({ type: 'text', text: '/probe-project typed arguments' });
      expect(first.blocks.slice(0, -1).map((part: { text: string }) => part.text).join('\n')).toContain('<cezar-context id="handoff"');
      expect(result.events.some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  nativeStart: runner => async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-step-wire-'));
    const wireFile = join(dir, 'wire.ndjson');
    const argsFile = join(dir, 'args.ndjson');
    try {
      const result = await driveRun(runner, { prompt: 'native step arguments' }, run => run?.status === 'waiting' || run?.status === 'failed', 30_000, undefined, {
        workflowDef: plannedWorkflow(skillTaskSteps('probe-project')),
        env: { CEZ_MOCK_STDIN_FILE: wireFile, CEZ_MOCK_ARGS_FILE: argsFile },
        beforeStart: ({ manager, repoRoot }) => {
          writeFileSync(join(repoRoot, '.ai/cezar/context.yaml'), 'version: 1\nrules:\n  - id: native-opening\n    on: session_start\n    target: both\n    template: CONTEXT-RULE-NATIVE-SENTINEL\n');
          manager.setSkillCatalog(new RunnerSkillCatalog({ adapters: hostSkillCatalogAdapters({ [runner]: HARNESS_ADAPTERS[runner]!.mockBin }) }));
        },
      });
      expect(result.record?.error).toBeUndefined();
      expect(result.events.some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE'))).toBe(true);
      const wire = [read(argsFile), read(wireFile)].join('\n');
      expect(wire).toContain('probe-project');
      expect(wire).toContain('native step arguments');
      expect(wire).toContain('cezar-context');
      expect(wire).toContain('handoff');
      expect(wire).toContain('CONTEXT-RULE-NATIVE-SENTINEL');
      expect(wire).not.toContain('Selected skill:');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  relativeSkillPath: runner => async () => {
    const result = await driveRun(runner, { prompt: 'worktree arguments' }, run => run?.status === 'waiting' || run?.status === 'failed', 30_000, undefined, {
      workflowDef: plannedWorkflow(skillTaskSteps('probe-project')), worktree: true, skillPaths: { task: '.agents/skills/probe-project/SKILL.md' },
      beforeStart: ({ manager }) => manager.setSkillCatalog(new RunnerSkillCatalog({ adapters: { [runner]: {
        discover: async (query: SkillCatalogQuery) => ({ skills: [{ id: 'probe-project', name: 'Probe', scope: 'repo', path: join(query.cwd, '.agents/skills/probe-project/SKILL.md') }], problems: [] }),
      } } })),
    });
    expect(result.record?.error).toBeUndefined();
    expect(result.record?.worktreePath).toBeTruthy();
    expect(result.record?.steps[0]?.skillPath).toBe('.agents/skills/probe-project/SKILL.md');
    expect(result.events.some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE'))).toBe(true);
  },
  typedTrigger: runner => async () => {
    await driveRun(runner, 'baseline', run => run?.status === 'waiting', 30_000, async ({ store, manager, runId }) => {
      expect(manager.sendMessage(runId, [{ type: 'text', text: '/probe-project typed arguments' }])).toBe(true);
      await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE')));
      const cwd = manager.delegationExecutionSettings(runId)?.cwd;
      if (!cwd) throw new Error('expected live session cwd');
      expect(existsSync(join(cwd, '.claude/skills'))).toBe(false);
      expect(existsSync(join(cwd, '.agents/skills'))).toBe(false);
      const run = store.getRun(runId)!;
      expect(run.queuedMessages ?? []).toEqual([]);
      expect(store.eventLog.readEvents(runId).some(event => event.type === 'user-message' && event.text === '/probe-project typed arguments')).toBe(true);
    }, {
      beforeStart: ({ manager, repoRoot }) => {
        manager.setSkillCatalog(fixedSkillCatalog([{ id: 'probe-project', name: 'Probe', scope: 'repo', path: join(repoRoot, 'SKILL.md') }]));
        expect(existsSync(join(repoRoot, '.claude/skills'))).toBe(false);
        expect(existsSync(join(repoRoot, '.agents/skills'))).toBe(false);
      },
    });
    if (runner === 'claude') await heldTrigger(runner);
  },
  stopDuringDiscovery: runner => async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let readStarted = false;
    try {
      const result = await driveRun(runner, { prompt: 'do it' }, run => run?.status === 'cancelled', 30_000, undefined, {
        workflowDef: plannedWorkflow(skillTaskSteps('probe-project')),
        beforeStart: ({ manager }) => manager.setSkillCatalog(new RunnerSkillCatalog({ adapters: { [runner]: {
          discover: async () => { readStarted = true; await held; return { skills: [], problems: [] }; },
        } } })),
        during: async ({ manager, runId }) => { await waitFor(() => readStarted); manager.cancel(runId); release(); },
      });
      expect(result.events.some(event => event.type === 'session')).toBe(false);
    } finally { release?.(); }
  },
};
