import { fileURLToPath } from 'node:url';

/** Base RPC flags shared by sessions and the no-model skill-list probe. A minimal session
 *  (`AgentRunSpec.minimal`) leaves out the project-skills extension: it loads no skills. */
export function piBaseArgs(opts: { projectSkills?: boolean } = {}): string[] {
  return ['--mode', 'rpc',
    '--extension', fileURLToPath(new URL('../../scripts/pi-retry-degraded-service.mjs', import.meta.url)),
    ...(opts.projectSkills === false ? [] : ['--extension', fileURLToPath(new URL('../../scripts/pi-project-skills.mjs', import.meta.url))])];
}
