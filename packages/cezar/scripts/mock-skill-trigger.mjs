import { existsSync } from 'node:fs';
import { captures } from './mock-skill-trigger-data.mjs';
export const SKILL_TOKEN = 'TRIGGER-FIXTURE';
export function slashTrigger(text, prefix = '/skill:') {
  if (!text.startsWith(prefix)) return;
  const match = /^([^\s]+)(?:[ \t]([^]*))?$/.exec(text.slice(prefix.length));
  if (!match?.[1].startsWith('probe-')) return;
  return { id: match[1], args: match[2] ?? '' };
}
export function knownSkill(runner, trigger) {
  return trigger.id === 'probe-project' || runner === 'codex' && trigger.id === 'probe-late' && existsSync(trigger.path);
}
/** Native payloads are cloned from captured CLI frames, with per-turn identities substituted. */
export function skillFrames(runner, trigger, context = '') {
  const frames = structuredClone(captures[runner]);
  const args = [trigger.args, context].filter(Boolean).join('\n\n');
  const replace = value => typeof value === 'string' ? value
    .replaceAll('/probe/repo', process.cwd())
    .replaceAll('fixture arguments\n\nOpening context: this is a native skill probe.', args)
    .replaceAll('fixture arguments', trigger.args)
    .replaceAll('Opening context: this is a native skill probe.', context)
    .replaceAll('probe-project', trigger.id) : value;
  return JSON.parse(JSON.stringify(frames), (_key, value) => replace(value));
}

export function claudeTrigger(blocks) {
  const last = blocks.at(-1);
  return last?.type === 'text' ? slashTrigger(last.text, '/') : undefined;
}
export function skillUserMessage(runner, text) {
  const trigger = slashTrigger(text);
  return trigger && knownSkill(runner, trigger) ? skillFrames(runner, trigger)[0].message : { role: 'user', content: [{ type: 'text', text }] };
}
