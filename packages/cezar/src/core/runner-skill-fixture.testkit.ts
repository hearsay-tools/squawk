import { RUNNER_IDS } from './agent-runner.ts';
import { RunnerSkillCatalog } from './runner-skill-catalog.ts';
import type { RunnerSkill } from '@open-mercato/cezar-contract/runner-skills';

/** Unit fixtures inject a list; native-wire parity supplies the actual probe adapters. */
export function fixedSkillCatalog(skills: readonly RunnerSkill[] = []): RunnerSkillCatalog {
  return new RunnerSkillCatalog({ adapters: Object.fromEntries(RUNNER_IDS.map(runner => [runner, {
    discover: async () => ({ skills: [...skills], problems: [] }),
  }])) });
}
