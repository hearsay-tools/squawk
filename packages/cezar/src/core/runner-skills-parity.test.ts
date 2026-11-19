import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runnerSkillListSchema } from '@open-mercato/cezar-contract/runner-skills';
import { HARNESS_ADAPTERS } from './harness-parity-core.testkit.ts';
import { parityRunners } from './parity-classes.testkit.ts';
import { hostSkillCatalogAdapters } from './host-skill-catalog.ts';
import { RunnerSkillCatalog } from './runner-skill-catalog.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

// The list parity runs on every runner.
registerBuiltInRunners();

describe('native runner skills list parity', () => {
  for (const runner of parityRunners('runner-skills', 'list')) {
    it(`${runner}: lists project, user and plugin metadata through its native wire`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'skills-parity-'));
      try {
        const catalog = new RunnerSkillCatalog({ adapters: hostSkillCatalogAdapters({ [runner]: HARNESS_ADAPTERS[runner].mockBin }) });
        const result = runnerSkillListSchema.parse(await catalog.get({ runner, cwd }));
        expect(result.source).toBe('live');
        expect(result.skills).toContainEqual(expect.objectContaining({ id: 'probe-project', scope: 'repo' }));
        expect(result.skills.some(s => s.scope === 'user')).toBe(true);
        expect(result.skills.some(s => s.plugin)).toBe(true);
        // Only these native list surfaces report per-skill problems.
        const capture = JSON.parse(await readFile(new URL(`./__fixtures__/${runner}/skill-list.json`, import.meta.url), 'utf8'));
        const problemCount = runner === 'codex' ? capture.result.data[0].errors.length
          : runner === 'omp' ? capture.warnings.length : 0;
        expect(result.problems).toHaveLength(problemCount);
      } finally { await rm(cwd, { recursive: true, force: true }); }
    }, 20_000); // bound: a CLI list probe has a 15-second deadline, including cold mock startup.
  }
});
