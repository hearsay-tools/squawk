import type { AgentRunSpec, ContentBlock, SkillTrigger } from './agent-runner.ts';

/** Adapters reject misplaced triggers before writing any native input. */
export function validSkillMessage(content: readonly ContentBlock[]): boolean {
  return content.every((block, index) => block.type !== 'skill' || index === 0);
}

export function skillOf(content: readonly ContentBlock[]): SkillTrigger | undefined {
  return content[0]?.type === 'skill' ? content[0] : undefined;
}

/** The adapter supplies the bootstrap result. A fresh fallback receives the Continue as arguments. */
export function openingInput(spec: AgentRunSpec, resumed: boolean): { skill: SkillTrigger | undefined; userPrompt: string } {
  if (spec.skill || resumed || !spec.resumeFallbackSkill) return { skill: spec.skill, userPrompt: spec.userPrompt };
  return { skill: { ...spec.resumeFallbackSkill, args: [spec.resumeFallbackSkill.args, spec.userPrompt].filter(Boolean).join('\n\n') }, userPrompt: '' };
}
export function openingContent(spec: AgentRunSpec, resumed: boolean): ContentBlock[] {
  const { skill, userPrompt } = openingInput(spec, resumed);
  return [
    ...(skill ? [{ type: 'skill' as const, ...skill }] : []),
    ...(spec.images ?? []),
    { type: 'text', text: userPrompt },
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
