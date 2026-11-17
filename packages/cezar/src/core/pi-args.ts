import { fileURLToPath } from 'node:url';

/** Base RPC flags shared by sessions and the no-model skill-list probe. A minimal session
 *  (`AgentRunSpec.minimal`) leaves out the project-skills extension: it loads no skills. */
export function piBaseArgs(opts: { projectSkills?: boolean } = {}): string[] {
  return ['--mode', 'rpc',
    '--extension', fileURLToPath(new URL('../../scripts/pi-retry-degraded-service.mjs', import.meta.url)),
    ...(opts.projectSkills === false ? [] : ['--extension', fileURLToPath(new URL('../../scripts/pi-project-skills.mjs', import.meta.url))])];
}

/** pi's flags for a minimal session: no discovered extensions, skills, prompt templates, themes,
 *  context files or MCP servers, and no saved session. Explicit
 *  `--extension` paths still load. */
export const PI_MINIMAL_ARGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
  '--no-context-files', '--no-mcp', '--no-session'] as const;
