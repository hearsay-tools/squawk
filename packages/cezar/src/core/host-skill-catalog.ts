import type { RunnerId } from './agent-runner.ts';
import { discoverClaudeSkills } from './claude-skill-catalog.ts';
import { discoverCodexSkills } from './codex-skill-catalog.ts';
import { discoverOpencodeSkills } from './opencode-skill-catalog.ts';
import { discoverPiSkills } from './pi-skill-catalog.ts';
import { discoverOmpSkills } from './omp-skill-catalog.ts';
import type { RunnerSkillCatalogAdapter } from './runner-skill-catalog.ts';
import type { SkillDiscoveryOptions } from './skill-probe.ts';

/** No product reader until the switch slice. Each caller supplies its folder and account home. */
export function hostSkillCatalogAdapters(overrides: Partial<Record<RunnerId, SkillDiscoveryOptions['bin']>> = {}): Record<RunnerId, RunnerSkillCatalogAdapter> {
  const adapter = (runner: RunnerId, discover: typeof discoverClaudeSkills): RunnerSkillCatalogAdapter => ({
    discover: (query, signal) => discover({ ...query, bin: overrides[runner], signal }),
  });
  return {
    claude: adapter('claude', discoverClaudeSkills), codex: adapter('codex', discoverCodexSkills),
    opencode: adapter('opencode', discoverOpencodeSkills), pi: adapter('pi', discoverPiSkills), omp: adapter('omp', discoverOmpSkills),
  };
}
