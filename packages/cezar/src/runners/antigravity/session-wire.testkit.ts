import { expect } from 'vitest';
import type { SessionWire } from '../../workflows/native-session-wire.testkit.ts';
function requests(wire: readonly unknown[], method: string): Record<string, unknown>[] {
  return wire.flatMap(row => typeof row === 'object' && row !== null && 'method' in row && row.method === method && 'params' in row
    ? [row.params as Record<string, unknown>] : []);
}
function prompts(wire: readonly unknown[]): string[] {
  return requests(wire, 'session/prompt').map(params => (params.prompt as { type: string; text?: string }[]).flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n'));
}
export const ANTIGRAVITY_SESSION_WIRE: SessionWire = {
  resumed: wire => requests(wire, 'session/resume').map(params => String(params.sessionId)),
  freshSessions: wire => requests(wire, 'session/new').length,
  started: wire => requests(wire, 'initialize').length > 0,
  effort: wire => requests(wire, 'session/set_config_option').filter(params => params.configId === 'thinking_level').at(-1)?.value as string | undefined,
  prompts: recording => prompts(recording.stdin), steers: () => [],
  systemPrompt: recording => [...requests(recording.args, 'session/new'), ...requests(recording.args, 'session/resume')].map(params => (params._meta as { antigravity?: { systemPrompt?: { append?: string } } })?.antigravity?.systemPrompt?.append ?? '').join('\n'),
  skillTriggers: (recording, name) => prompts(recording.stdin).filter(text => name ? text.startsWith(`/${name} `) || text === `/${name}` : /^\/[\w-]+(?: |$)/.test(text)),
  expectSkillTrigger: (recording, trigger) => {
    expect(prompts(recording.stdin)).toContain(`/${trigger.name}${trigger.args ? ` ${trigger.args}` : ''}${trigger.context ? `\n${trigger.context}` : ''}`);
  },
};
