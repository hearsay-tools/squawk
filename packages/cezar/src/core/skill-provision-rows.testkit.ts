import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { expect } from 'vitest';
import { collectedOnly, partitionParity, type CellBody, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { SKILL_PROVISION_CRITERIA } from './harness-parity-core.testkit.ts';
import { PARITY_ROSTER } from './parity-classes.testkit.ts';

// The skill-provision cells and their partition, apart from the engine the cell bodies drive,
// so the registration guard collects the same names without loading it.
const PARTS = {
  'start-and-stop': ['claude unconverted opening command keeps character zero on the native wire', 'claude typed opening skill carries session context on the native wire', 'claude R92', 'codex R92', 'opencode R92', 'pi R92', 'omp R92', 'fixture R96', ...BUILT_IN_RUNNER_IDS.map(runner => `${runner} relative project skillPath starts in a task worktree`)],
  continue: ['fixture R93'], recovery: ['fixture R94'],
  'slash-install': ['claude R95', 'codex R95', 'opencode R95', 'pi R95', 'omp R95'],
};

type RunnerCell = (runner: string) => CellBody;
export type SkillProvisionCells = {
  openingCommand: CellBody; openingSkill: CellBody;
  nativeStart: RunnerCell; missingId: RunnerCell; ambiguousId: RunnerCell;
  relativeSkillPath: RunnerCell; typedTrigger: RunnerCell; stopDuringDiscovery: RunnerCell;
};

/** These rows replace the removed injection/provisioning mechanism with native selection. */
export function skillProvisionParity(cells: SkillProvisionCells) {
  return function describeSkillProvisionParity(part: ParityPart, collect?: ParityCollector): void {
    const { describe, it } = partitionParity(part, PARTS, collect, 'skill-provision');
    describe('native skill selection through the run path', () => {
      expect(SKILL_PROVISION_CRITERIA.map(row => row.id)).toEqual(['R92', 'R93', 'R94', 'R95', 'R96']);
      it('claude unconverted opening command keeps character zero on the native wire', cells.openingCommand);
      it('claude typed opening skill carries session context on the native wire', cells.openingSkill);
      for (const runner of PARITY_ROSTER) {
        it(`${runner} R92 starts the selected skill natively with opening context and no injected body`, cells.nativeStart(runner), 45_000); // bound: native list, session and cleanup each own a bounded process.
        it(`${runner} R93 refuses a missing selected id before a model call`, cells.missingId(runner));
        it(`${runner} R94 refuses an ambiguous selected id and names every listed path`, cells.ambiguousId(runner), 60_000); // bound: both ambiguity cases must settle before any session opens.
        if ((BUILT_IN_RUNNER_IDS as readonly string[]).includes(runner)) {
          it(`${runner} relative project skillPath starts in a task worktree`, cells.relativeSkillPath(runner), 45_000); // bound: one worktree setup, native turn and teardown.
        }
        it(`${runner} R95 turns a typed name into a native trigger without provisioning files`, cells.typedTrigger(runner), 60_000); // bound: the typed trigger must acknowledge and complete on the native wire.
        it(`${runner} R96 Stop during native list discovery launches no session`, cells.stopDuringDiscovery(runner));
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const skillProvisionCellNames = skillProvisionParity({
  openingCommand: collectedOnly(), openingSkill: collectedOnly(),
  nativeStart: collectedOnly, missingId: collectedOnly, ambiguousId: collectedOnly,
  relativeSkillPath: collectedOnly, typedTrigger: collectedOnly, stopDuringDiscovery: collectedOnly,
});
