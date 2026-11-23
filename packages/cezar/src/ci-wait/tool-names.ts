import { enabledAgentTools, registeredAgentTools } from './tool-registry.ts';

export function squawkToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return enabledAgentTools(env).map(tool => tool.name);
}
/** A feature may need its disabling flag forwarded even when it is disabled. */
export function squawkToolEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set(['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET', ...registeredAgentTools().flatMap(tool => tool.envNames?.(env) ?? []).sort()]);
  return [...names].flatMap(name => {
    const preferred = name.replace(/^CEZ_/, 'HSQ_');
    return env[preferred] === undefined ? [name] : [name, preferred];
  });
}
