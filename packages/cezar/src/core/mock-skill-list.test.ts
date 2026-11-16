import { homedir } from 'node:os'; // test-home-read: compare mock metadata paths only; no home file is read or written.
import { describe, expect, it } from 'vitest';
import { mockSkillList } from '../../scripts/mock-skill-list.mjs';
import { captures } from '../../scripts/mock-skill-list-data.mjs';
import { RUNNER_IDS } from './agent-runner.ts';

describe('native mock skill paths', () => {
  for (const runner of RUNNER_IDS) it(`${runner}: substitutes string values before wire serialization`, () => {
    const cwd = 'C:\\Users\\probe\\repo "quoted" $&\nfolder';
    const original = structuredClone(captures[runner]);
    const result = mockSkillList(runner, cwd);
    const strings: string[] = [];
    JSON.parse(JSON.stringify(result), (_key, value) => {
      if (typeof value === 'string') strings.push(value);
      return value;
    });
    if (runner === 'claude') expect(result).toEqual(original); // Claude's list has no paths.
    else {
      const folder = runner === 'pi' ? '.pi' : runner === 'omp' ? '.omp' : '.agents';
      expect(strings).toContain(`${cwd}/${folder}/skills/probe-project/SKILL.md`);
      expect(strings).toContain(`${homedir()}/.agents/skills/capture/SKILL.md`); // test-home-read: compare mock metadata only.
    }
    expect(captures[runner]).toEqual(original);
  });
});
