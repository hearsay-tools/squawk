import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunnerSkill, RunnerSkillList } from '@open-mercato/cezar-contract/runner-skills';
import type { RunnerId } from './agent-runner.ts';

export type SkillReferenceResult = { skill: RunnerSkill; error?: never } | { skill?: never; error: string };

/** Name-only references follow the runner's scope. A path selects exactly one listed copy. */
export function resolveRunnerSkill(skills: readonly RunnerSkill[], reference: { id: string; path?: string | undefined }, context: { runner: RunnerId; account: string; cwd: string }): SkillReferenceResult {
  const copies = skills.filter(skill => skill.id === reference.id);
  const identity = `${context.runner} account "${context.account}" skill "${reference.id}"`;
  const paths = copies.map(skill => skill.path ?? '(path not reported)').join(', ');
  if (reference.path !== undefined) {
    const path = resolve(context.cwd, reference.path);
    const found = copies.filter(skill => skill.path !== undefined && resolve(context.cwd, skill.path) === path);
    if (found.length === 1) return { skill: found[0]! };
    return { error: `${identity}: selected path ${path} is not in this worktree's list. Listed paths: ${paths || '(none)'}` };
  }
  if (!copies.length) {
    const close = skills.filter(skill => skill.id.includes(reference.id) || reference.id.includes(skill.id)).slice(0, 10);
    return { error: `${identity} is missing from this worktree's list. Close ids: ${close.map(skill => `${skill.id} (${skill.path ?? 'path not reported'})`).join(', ') || '(none)'}. Listed paths: ${skills.map(skill => skill.path).filter(Boolean).join(', ') || '(none)'}` };
  }
  if (copies.length === 1) return { skill: copies[0]! };
  const rank = { repo: 0, user: 1, system: 2 };
  const unknown = copies.some(skill => !skill.scope || skill.scope === 'other');
  const best = Math.min(...copies.map(skill => skill.scope && skill.scope !== 'other' ? rank[skill.scope] : Infinity));
  const winners = copies.filter(skill => skill.scope && skill.scope !== 'other' && rank[skill.scope] === best);
  return !unknown && winners.length === 1 ? { skill: winners[0]! }
    : { error: `${identity} is ambiguous. Listed paths: ${paths}` };
}

/** Only a list response uses relative paths; the catalog retains the runner's native paths. */
export function portableRunnerSkillList(list: RunnerSkillList, cwd: string): RunnerSkillList {
  return { ...list, skills: list.skills.map(skill => {
    if (!skill.path) return skill;
    const path = relative(cwd, skill.path);
    return { ...skill, path: path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : skill.path };
  }) };
}
