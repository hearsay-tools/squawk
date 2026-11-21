import '../core/register-all-runners.testkit.ts';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runnerSkillListSchema } from '@open-mercato/cezar-contract/runner-skills';
import { HARNESS_ADAPTERS } from './harness-parity-core.testkit.ts';
import { parityRunners } from './parity-classes.testkit.ts';
import { hostSkillCatalogAdapters } from './host-skill-catalog.ts';
import { runnerDefinition } from './runner-registry.ts';
import { RunnerSkillCatalog } from './runner-skill-catalog.ts';

// The list parity runs on every runner.

describe('native runner skills list parity', () => {
  for (const runner of parityRunners('runner-skills', 'list')) {
    it(`${runner}: lists project, user and plugin metadata through its native wire`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'skills-parity-'));
      const accountHome = join(cwd, 'user-home');
      const sources = runnerDefinition(runner).skillCatalog;
      try {
        if (sources?.source === 'filesystem') {
          for (const [scope, root, id] of [['repo', sources.projectRoots[0], 'probe-project'], ['user', sources.userRoots[0], 'probe-user']]) {
            const folder = join(scope === 'repo' ? cwd : accountHome, root!, id!);
            await mkdir(folder, { recursive: true });
            await writeFile(join(folder, 'SKILL.md'), `---\nname: ${id}\ndescription: parity probe\n---\nProbe.`);
          }
        }
        const catalog = new RunnerSkillCatalog({ adapters: hostSkillCatalogAdapters({ [runner]: HARNESS_ADAPTERS[runner]!.mockBin }) });
        const result = runnerSkillListSchema.parse(await catalog.get({ runner, cwd, ...(sources ? { accountHome } : {}) }));
        expect(result.source).toBe('live');
        expect(result.skills).toContainEqual(expect.objectContaining({ id: 'probe-project', scope: 'repo' }));
        expect(result.skills.some(s => s.scope === 'user')).toBe(true);
        expect(result.skills.some(s => s.plugin)).toBe(sources?.plugins !== false);
        // Only these native list surfaces report per-skill problems.
        if (sources?.source === 'filesystem') { expect(result.problems).toEqual([]); return; }
        const capture = JSON.parse(await readFile(new URL(`../runners/${runner}/__fixtures__/skill-list.json`, import.meta.url), 'utf8'));
        const problemCount = runner === 'codex' ? capture.result.data[0].errors.length
          : runner === 'omp' ? capture.warnings.length : 0;
        expect(result.problems).toHaveLength(problemCount);
      } finally { await rm(cwd, { recursive: true, force: true }); }
    }, 20_000); // bound: a CLI list probe has a 15-second deadline, including cold mock startup.
  }
});
