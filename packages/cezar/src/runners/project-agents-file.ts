import { join } from 'node:path';
import type { ConfigFileDef } from '../core/runner-config-files.ts';

const OPENCODE_RULES_DOCS = 'https://opencode.ai/docs/rules/';

/**
 * `<repo>/AGENTS.md` is read by Codex, OpenCode, Pi AND OMP. Each of their definitions lists this
 * one entry in its `configFiles`; the agent-config catalog lists it once. Data only.
 */
export const PROJECT_AGENTS_FILE: ConfigFileDef = {
  id: 'project.agents',
  runners: ['codex', 'opencode', 'pi', 'omp'],
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
