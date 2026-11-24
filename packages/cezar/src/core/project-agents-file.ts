import { join } from 'node:path';
import type { RunnerConfigFile } from './runner-config-files.ts';

const OPENCODE_RULES_DOCS = 'https://opencode.ai/docs/rules/';

/**
 * `<repo>/AGENTS.md`, one file that several runners read. Each reader's definition lists this one
 * entry in its `configFiles`; the agent-config catalog lists it once, read by each of them. Data only.
 */
export const PROJECT_AGENTS_FILE: RunnerConfigFile = {
  id: 'project.agents',
  kind: 'memory',
  scope: 'project',
  resolve: (repo) => join(repo, 'AGENTS.md'),
  label: 'AGENTS.md',
  format: 'markdown',
  tracked: 'tracked',
  precedence:
    'Read by Codex, OpenCode, Pi and OMP (Claude ignores it). Codex concatenates it root-down; OpenCode uses the first match and prefers it over CLAUDE.md; Pi concatenates every AGENTS.md (or CLAUDE.md) from the parent directories down, after its global file; OMP loads standalone ancestor AGENTS.md files through its low-priority `agents-md` provider. Runs read the committed copy.',
  docsUrl: OPENCODE_RULES_DOCS,
};
