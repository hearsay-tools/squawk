import { expect } from 'vitest';
import type { RunnerSkill } from '@open-mercato/cezar-contract/runner-skills';
import type { CellBody } from './parity-partition.testkit.ts';
import { fixedSkillCatalog } from './runner-skill-fixture.testkit.ts';
import { skillProvisionParity, type SkillProvisionCells } from './skill-provision-rows.testkit.ts';
import { createActiveRun } from '../workflows/active-run.ts';
import { RunSkills } from '../workflows/run/run-skills.ts';
import type { RunModuleContext } from '../workflows/run/types.ts';
import { unused } from '../workflows/unused.testkit.ts';
import { registerRunner } from './runner-registry.ts';
import { BUILT_IN_RUNNERS } from '../runners/built-in.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';

// R93 and R94 resolve the selected skill above the session: step-session.ts calls
// RunSkills.selectedSkill before it launches one, so a throw there means no session event.
// These cells drive RunSkills alone and load no engine. The other cells run a workflow through
// RunManager: their part files call installSkillProvisionEngine()
// (skill-provision-engine.testkit.ts) before they register, so a module part file never imports run.ts.

type EngineCellBody = 'openingCommand' | 'openingSkill';
type EngineRunnerCell = 'nativeStart' | 'relativeSkillPath' | 'typedTrigger' | 'stopDuringDiscovery';
export type SkillProvisionEngineCells = Pick<SkillProvisionCells, EngineCellBody | EngineRunnerCell>;

let engineCells: SkillProvisionEngineCells | undefined;

/** Called by `skill-provision-engine.testkit.ts` only. */
export function setSkillProvisionEngineCells(cells: SkillProvisionEngineCells): void {
  engineCells = cells;
}

function installed(cell: string): SkillProvisionEngineCells {
  if (!engineCells) throw new Error(`${cell} runs on the engine: call installSkillProvisionEngine() before describeSkillProvisionParity`);
  return engineCells;
}

const engineCell = (key: EngineCellBody): CellBody => () => installed(key)[key]();
const engineRunnerCell = (key: EngineRunnerCell) => (runner: string): CellBody => () => installed(`${runner} ${key}`)[key](runner)();

/** Selects a skill the way a step opens on `runner` with the default account and `skills` listed. */
async function selection(runner: string, skills: readonly RunnerSkill[]): Promise<(id: string, path?: string) => unknown> {
  // The skill catalog lists only registered runners, so the cell registers the runner it drives.
  registerRunner(runner === fixtureRunner.id ? fixtureRunner : BUILT_IN_RUNNERS.find(definition => definition.id === runner)!);
  const runSkills = new RunSkills(unused<RunModuleContext>('run context', { skillCatalog: fixedSkillCatalog(skills) }));
  const state = createActiveRun({ cwd: '/repo', pendingHumanAsk: false, autonomous: false });
  await runSkills.loadRunSkills(state, runner, { env: {}, profileId: 'default' });
  return (id, path) => runSkills.selectedSkill(state, id, path, 'do it');
}

export const describeSkillProvisionParity = skillProvisionParity({
  openingCommand: engineCell('openingCommand'),
  openingSkill: engineCell('openingSkill'),
  nativeStart: engineRunnerCell('nativeStart'),
  missingId: runner => async () => {
    const missing = await selection(runner, [{ id: 'missing-close', name: 'Close', path: '/listed/close', scope: 'repo' }]);
    expect(() => missing('missing')).toThrow(`${runner} account "default"`);
    expect(() => missing('missing')).toThrow('missing-close');
    const stale = await selection(runner, [{ id: 'listed', name: 'Listed', path: '/new/SKILL.md', scope: 'repo' }]);
    expect(() => stale('listed', '/old/SKILL.md')).toThrow('selected path /old/SKILL.md');
    expect(() => stale('listed', '/old/SKILL.md')).toThrow('/new/SKILL.md');
  },
  ambiguousId: runner => async () => {
    const duplicate = await selection(runner, ['/one', '/two'].map(path => ({ id: 'duplicate', name: 'Duplicate', path, scope: 'repo' as const })));
    expect(() => duplicate('duplicate')).toThrow('ambiguous');
    expect(() => duplicate('duplicate')).toThrow('/one'); expect(() => duplicate('duplicate')).toThrow('/two');
    const other = await selection(runner, [{ id: 'other', name: 'Other', path: '/admin/SKILL.md', scope: 'other' }, { id: 'other', name: 'Other', path: '/repo/SKILL.md', scope: 'repo' }]);
    expect(() => other('other')).toThrow('ambiguous');
    expect(() => other('other')).toThrow('/admin/SKILL.md');
    expect(() => other('other')).toThrow('/repo/SKILL.md');
  },
  relativeSkillPath: engineRunnerCell('relativeSkillPath'),
  typedTrigger: engineRunnerCell('typedTrigger'),
  stopDuringDiscovery: engineRunnerCell('stopDuringDiscovery'),
});
