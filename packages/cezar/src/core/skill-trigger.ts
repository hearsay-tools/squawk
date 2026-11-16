import type { AgentRunSpec, ContentBlock, SkillTrigger } from './agent-runner.ts';

/** Adapters reject misplaced triggers before writing any native input. */
export function validSkillMessage(content: readonly ContentBlock[]): boolean {
  return content.every((block, index) => block.type !== 'skill' || index === 0);
}

export function skillOf(content: readonly ContentBlock[]): SkillTrigger | undefined {
  return content[0]?.type === 'skill' ? content[0] : undefined;
}

/** Only adapters use this; shared workflow code does not send triggers yet. */
export function openingContent(spec: AgentRunSpec): ContentBlock[] {
  return [
    ...(spec.skill ? [{ type: 'skill' as const, ...spec.skill }] : []),
    ...(spec.images ?? []),
    { type: 'text', text: spec.userPrompt },
  ];
}

/** pi splits the name at the first space, so a newline cannot be the first argument. */
export function slashSkillPrompt(skill: SkillTrigger, context: string): string {
  const args = skill.args.split('\n')[0]?.trim() ? skill.args : `Continue.${skill.args ? ` ${skill.args}` : ''}`;
  return `/skill:${skill.id} ${args}${context ? `\n\n${context}` : ''}`;
}

/** Claude expands only the last text block, with context before it. */
export function claudeSkillContent(content: ContentBlock[], allowed: boolean): ContentBlock[] | false {
  if (!validSkillMessage(content)) return false;
  const skill = skillOf(content);
  if (!skill) return content;
  if (!allowed) return false;
  return [...content.slice(1), { type: 'text', text: `/${skill.id}${skill.args ? ` ${skill.args}` : ''}` }];
}
