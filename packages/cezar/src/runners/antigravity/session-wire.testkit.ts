import { expect } from 'vitest';
import { systemFromPrepended, type SessionWire } from '../../workflows/native-session-wire.testkit.ts';
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
  started: wire => requests(wire, 'session/prompt').length > 0,
  effort: wire => requests(wire, 'session/set_config_option').filter(params => params.configId === 'thought_level').at(-1)?.value as string | undefined,
  prompts: recording => prompts(recording.stdin), steers: () => [],
  // session/new carries it on the saved channel; a resume prepends it to the opening turn.
  systemPrompt: recording => requests(recording.args, 'session/new').length
    ? requests(recording.args, 'session/new').map(params => (params._meta as { antigravity?: { systemPrompt?: { append?: string } } })?.antigravity?.systemPrompt?.append ?? '').join('\n')
    : prompts(recording.stdin)[0] ?? '',
  systemPrompts: recording => {
    const created = requests(recording.args, 'session/new')
      .map(params => (params._meta as { antigravity?: { systemPrompt?: { append?: string } } })?.antigravity?.systemPrompt?.append)
      .filter((text): text is string => typeof text === 'string' && text.length > 0);
    return created.length > 0 ? created : prompts(recording.stdin).map(systemFromPrepended);
  },
  skillTriggers: (recording, name) => prompts(recording.stdin).filter(text => name ? text.startsWith(`/${name} `) || text.startsWith(`/${name}\n`) || text === `/${name}` : /^\/[\w-]+(?:\s|$)/.test(text)),
  expectSkillTrigger: (recording, trigger) => {
    expect(prompts(recording.stdin)).toContain(`/${trigger.name}${trigger.args ? ` ${trigger.args}` : ''}${trigger.context ? `\n${trigger.context}` : ''}`);
  },
  expectCiWire: (rows, { resume }) => {
    const params = requests(rows, resume ? 'session/resume' : 'session/new')[0];
    expect(params?.mcpServers).toEqual([expect.objectContaining({ type: 'http', name: 'squawk' })]);
  },
  expectSquawkToolAdmission: () => {},
};
