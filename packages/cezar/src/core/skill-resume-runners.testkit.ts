import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import type { RunnerDefinition } from './runner-definition.ts';
import { sealTestRunners } from './runner-registry.testkit.ts';
import { skillResumeCellNames } from './skill-resume-rows.testkit.ts';

/** Boot the runners selected by this partition, including new runners whose cells follow
 * the first part for their row. File names describe the original partition, not its roster. */
export async function sealSkillResumeRunners(part: string): Promise<void> {
  const names: string[] = [];
  skillResumeCellNames(part, name => names.push(name));
  const ids = [...new Set(names.map(name => name.split(' ')[0]!))]
    .filter(id => (BUILT_IN_RUNNER_IDS as readonly string[]).includes(id));
  if (!ids.length) throw new Error(`Skill-resume part ${part} selects no runner`);
  const definitions = await Promise.all(ids.map(async id => {
    const exports = Object.values(await import(`../runners/${id}/definition.ts`)) as RunnerDefinition[];
    if (exports.length !== 1 || exports[0]?.id !== id) throw new Error(`Runner ${id} must export its definition`);
    return exports[0];
  }));
  sealTestRunners(...definitions);
}
