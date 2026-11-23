import { automationsToolEnabled, previewToolEnabled } from './tool-env.ts';

/**
 * Tool names in the same order `squawkToolDefinitions` advertises them. A leaf, so a runner that
 * only needs the names never loads the tool schemas; `ci-wait/tools.test.ts` pins the two lists together.
 */
export function squawkToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    'cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done',
    ...(previewToolEnabled(env) ? ['cezar_preview_serve', 'cezar_preview_stop'] : []),
    ...(automationsToolEnabled(env) ? ['cezar_schedule_task', 'cezar_automation', 'cezar_scheduled_tasks'] : []),
  ];
}

/**
 * Env names a harness must forward to the adapter process. Several harnesses spawn MCP servers
 * from an allowlist, so preview opt-in and automations opt-out must both reach the adapter.
 */
export function squawkToolEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET', 'CEZ_AUTOMATIONS', ...(previewToolEnabled(env) ? ['CEZ_PREVIEW'] : [])]
    .flatMap(name => { const preferred = name.replace(/^CEZ_/, 'HSQ_'); return env[preferred] === undefined ? [name] : [name, preferred]; });
}
