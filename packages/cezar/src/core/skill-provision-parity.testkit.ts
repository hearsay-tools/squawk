import { partitionParity, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { SKILL_PROVISION_CRITERIA, waitFor } from './harness-parity-core.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';
import { fixedSkillCatalog } from './runner-skill-fixture.testkit.ts';
import { hostSkillCatalogAdapters } from './host-skill-catalog.ts';
import { RunnerSkillCatalog, type SkillCatalogQuery } from './runner-skill-catalog.ts';
import { HARNESS_ADAPTERS } from './harness-parity-core.testkit.ts';
import { plannedWorkflow, skillTaskSteps } from '../workflows/types.ts';

const PARTS = {
  'start-and-stop': ['claude R92', 'codex R92', 'opencode R92', 'pi R92', 'omp R92', 'claude R96', ...RUNNER_IDS.map(runner => `${runner} relative project skillPath starts in a task worktree`)],
  continue: ['claude R93'], recovery: ['claude R94'],
  'slash-install': ['claude R95', 'codex R95', 'opencode R95', 'pi R95', 'omp R95'],
};
const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : '';

/** A native gate proves the trigger stays above the seam until the running turn ends. */
async function heldTrigger(runner: RunnerId): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'held-native-trigger-'));
  const wire = join(dir, 'stdin.ndjson');
  const release = join(dir, 'release');
  try {
    await driveRun(runner, 'hold-gated', run => run?.status === 'waiting', 30_000, undefined, {
      env: { CEZ_MOCK_STDIN_FILE: wire, CEZ_MOCK_RELEASE_FILE: release },
      beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog([{ id: 'probe-project', name: 'Probe', path: '/listed/SKILL.md', scope: 'repo' }])),
      during: async ({ store, manager, runId }) => {
        await waitFor(() => store.readEvents(runId).some(event => event.type === 'turn.started'));
        expect(manager.sendMessage(runId, [{ type: 'text', text: '/probe-project held arguments' }])).toBe(true);
        expect(store.getRun(runId)?.queuedMessages?.[0]?.text).toBe('/probe-project held arguments');
        expect(read(wire)).not.toContain('probe-project'); // The gate holds the turn; no time-based absence wait.
        writeFileSync(release, 'baseline');
        await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE')));
        expect(read(wire)).toContain('probe-project');
      },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** These rows replace the removed injection/provisioning mechanism with native selection. */
export function describeSkillProvisionParity(part: ParityPart, collect?: ParityCollector): void {
  const { describe, it } = partitionParity(part, PARTS, collect, 'skill-provision');
  describe('native skill selection through the run path', () => {
    expect(SKILL_PROVISION_CRITERIA.map(row => row.id)).toEqual(['R92', 'R93', 'R94', 'R95', 'R96']);
    for (const runner of RUNNER_IDS) {
      it(`${runner} R92 starts the selected skill natively with opening context and no injected body`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'native-step-wire-'));
        const wireFile = join(dir, 'wire.ndjson');
        try {
          const result = await driveRun(runner, { prompt: 'native step arguments' }, run => run?.status === 'waiting', 30_000, undefined, {
            workflowDef: plannedWorkflow(skillTaskSteps('probe-project')),
            env: { CEZ_MOCK_STDIN_FILE: wireFile },
            beforeStart: ({ manager }) => manager.setSkillCatalog(new RunnerSkillCatalog({ adapters: hostSkillCatalogAdapters({ [runner]: HARNESS_ADAPTERS[runner].mockBin }) })),
          });
          expect(result.events.some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE'))).toBe(true);
          const wire = read(wireFile);
          expect(wire).toContain('probe-project');
          expect(wire).toContain('native step arguments');
          expect(wire).toContain('cezar-context');
          expect(wire).not.toContain('Selected skill:');
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 45_000); // bound: native list, session and cleanup each own a bounded process.

      it(`${runner} R93 refuses a missing selected id before a model call`, async () => {
        const result = await driveRun(runner, { prompt: 'do it' }, run => run?.status === 'failed', 30_000, undefined, {
          workflowDef: plannedWorkflow(skillTaskSteps('missing')),
          beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog([{ id: 'missing-close', name: 'Close', path: '/listed/close', scope: 'repo' }])),
        });
        expect(result.record?.error).toContain(`${runner} account "default"`);
        expect(result.record?.error).toContain('missing-close');
        expect(result.events.some(event => event.type === 'session')).toBe(false);
        const stale = await driveRun(runner, { prompt: 'do it' }, run => run?.status === 'failed', 30_000, undefined, {
          workflowDef: plannedWorkflow(skillTaskSteps('listed')), skillPaths: { task: '/old/SKILL.md' },
          beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog([{ id: 'listed', name: 'Listed', path: '/new/SKILL.md', scope: 'repo' }])),
        });
        expect(stale.record?.error).toContain('selected path /old/SKILL.md');
        expect(stale.record?.error).toContain('/new/SKILL.md');
        expect(stale.events.some(event => event.type === 'session')).toBe(false);
      });

      it(`${runner} R94 refuses an ambiguous selected id and names every listed path`, async () => {
        const result = await driveRun(runner, { prompt: 'do it' }, run => run?.status === 'failed', 30_000, undefined, {
          workflowDef: plannedWorkflow(skillTaskSteps('duplicate')),
          beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog(['/one', '/two'].map(path => ({ id: 'duplicate', name: 'Duplicate', path, scope: 'repo' })))),
        });
        expect(result.record?.error).toContain('ambiguous');
        expect(result.record?.error).toContain('/one'); expect(result.record?.error).toContain('/two');
        expect(result.events.some(event => event.type === 'session')).toBe(false);
        const other = await driveRun(runner, { prompt: 'do it' }, run => run?.status === 'failed', 30_000, undefined, {
          workflowDef: plannedWorkflow(skillTaskSteps('other')),
          beforeStart: ({ manager }) => manager.setSkillCatalog(fixedSkillCatalog([{ id: 'other', name: 'Other', path: '/admin/SKILL.md', scope: 'other' }])),
        });
        expect(other.record?.error).toContain('ambiguous');
        expect(other.record?.error).toContain('/admin/SKILL.md');
        expect(other.events.some(event => event.type === 'session')).toBe(false);
      }, 60_000); // bound: both ambiguity cases must settle before any session opens.

      it(`${runner} relative project skillPath starts in a task worktree`, async () => {
        const result = await driveRun(runner, { prompt: 'worktree arguments' }, run => run?.status === 'waiting', 30_000, undefined, {
          workflowDef: plannedWorkflow(skillTaskSteps('probe-project')), worktree: true, skillPaths: { task: '.agents/skills/probe-project/SKILL.md' },
          beforeStart: ({ manager }) => manager.setSkillCatalog(new RunnerSkillCatalog({ adapters: { [runner]: {
            discover: async (query: SkillCatalogQuery) => ({ skills: [{ id: 'probe-project', name: 'Probe', scope: 'repo', path: join(query.cwd, '.agents/skills/probe-project/SKILL.md') }], problems: [] }),
          } } })),
        });
        expect(result.record?.error).toBeUndefined();
        expect(result.record?.worktreePath).toBeTruthy();
        expect(result.record?.steps[0]?.skillPath).toBe('.agents/skills/probe-project/SKILL.md');
        expect(result.events.some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE'))).toBe(true);
      }, 45_000); // bound: one worktree setup, native turn and teardown.

      it(`${runner} R95 turns a typed name into a native trigger without provisioning files`, async () => {
        await driveRun(runner, 'baseline', run => run?.status === 'waiting', 30_000, async ({ store, manager, runId }) => {
          expect(manager.sendMessage(runId, [{ type: 'text', text: '/probe-project typed arguments' }])).toBe(true);
          await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE')));
          const cwd = manager.delegationExecutionSettings(runId)?.cwd;
          if (!cwd) throw new Error('expected live session cwd');
          expect(existsSync(join(cwd, '.claude/skills'))).toBe(false);
          expect(existsSync(join(cwd, '.agents/skills'))).toBe(false);
          const run = store.getRun(runId)!;
          expect(run.queuedMessages ?? []).toEqual([]);
          expect(store.readEvents(runId).some(event => event.type === 'user-message' && event.text === '/probe-project typed arguments')).toBe(true);
        }, {
          beforeStart: ({ manager, repoRoot }) => {
            manager.setSkillCatalog(fixedSkillCatalog([{ id: 'probe-project', name: 'Probe', scope: 'repo', path: join(repoRoot, 'SKILL.md') }]));
            expect(existsSync(join(repoRoot, '.claude/skills'))).toBe(false);
            expect(existsSync(join(repoRoot, '.agents/skills'))).toBe(false);
          },
        });
        if (runner === 'claude') await heldTrigger(runner);
      }, 60_000); // bound: the typed trigger must acknowledge and complete on the native wire.

      it(`${runner} R96 Stop during native list discovery launches no session`, async () => {
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
      });
    }
  });
}
