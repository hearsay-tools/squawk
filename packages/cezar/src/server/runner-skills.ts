import type { z } from 'zod';
import type { RunnerSkillList, runnerSkillsQuerySchema } from '@open-mercato/cezar-contract/runner-skills';

import { registeredRunnerId } from '../core/runner-registry.ts';
import type { RunnerSkillCatalog } from '../core/runner-skill-catalog.ts';
import { portableRunnerSkillList } from '../core/runner-skill-reference.ts';
import type { Home } from '../home/home.ts';
import { resolveProfileEnvForRoot, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';

/** Explicit API choices refuse unknown accounts; omitted choices follow the project's session account. */
export async function readRunnerSkills(
  input: z.infer<typeof runnerSkillsQuerySchema>,
  cwd: string,
  home: Home,
  catalog: RunnerSkillCatalog,
  resolveAccount: (runner: string, account: string) => Promise<{ profile: ResolvedAgentProfile } | { error: string }>,
): Promise<RunnerSkillList | { error: string }> {
  const { account, refresh } = input;
  const runner = registeredRunnerId(input.runner);
  if (account !== undefined) {
    const selected = await resolveAccount(runner, account);
    if ('error' in selected) return selected;
  }
  const resolved = await resolveProfileEnvForRoot(cwd, runner, account, process.env, home).catch(() => null);
  if (!resolved) return { error: `unknown or unavailable ${runner} account: ${account ?? 'project default'}` };
  const query = { runner, cwd, accountHome: resolved.profile.isDefault ? undefined : resolved.profile.path };
  if (refresh === '1') catalog.invalidate(query);
  return portableRunnerSkillList(await catalog.get(query), cwd);
}
