import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunnerSkill, RunnerSkillList } from '@open-mercato/cezar-contract/runner-skills';

export type SkillReferenceResult =
  | { skill: RunnerSkill; movedFromPath?: string | undefined; error?: never }
  | { skill?: never; error: string };

export interface ResolveRunnerSkillOptions {
  /** On Continue, fall back to D8 id resolution when the stored path disappears from the runner's list. */
  fallbackToId?: boolean | undefined;
}

/** Name-only references follow the runner's scope. A path selects exactly one listed copy unless `fallbackToId` allows falling back to D8 id resolution. */
export function resolveRunnerSkill(
  skills: readonly RunnerSkill[],
  reference: { id: string; path?: string | undefined },
  context: { runner: string; account: string; cwd: string },
  options?: ResolveRunnerSkillOptions,
): SkillReferenceResult {
  const copies = skills.filter(skill => skill.id === reference.id);
  const identity = `${context.runner} account "${context.account}" skill "${reference.id}"`;
  const paths = copies.map(skill => skill.path ?? '(path not reported)').join(', ');
  if (reference.path !== undefined) {
    const path = resolve(context.cwd, reference.path);
    const found = copies.filter(skill => skill.path !== undefined && resolve(context.cwd, skill.path) === path);
    if (found.length === 1) return { skill: found[0]! };
    if (!options?.fallbackToId) {
      return { error: `${identity}: selected path ${path} is not in this worktree's list. Listed paths: ${paths || '(none)'}` };
    }
    const fallback = resolveRunnerSkillById(skills, copies, reference.id, identity, paths);
    return fallback.error !== undefined ? fallback : { skill: fallback.skill, movedFromPath: path };
  }
  return resolveRunnerSkillById(skills, copies, reference.id, identity, paths);
}

function resolveRunnerSkillById(
  skills: readonly RunnerSkill[],
  copies: readonly RunnerSkill[],
  id: string,
  identity: string,
  paths: string,
): SkillReferenceResult {
  if (!copies.length) {
    const close = skills.filter(skill => skill.id.includes(id) || id.includes(skill.id)).slice(0, 10);
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

/** Paths inside `cwd` stay relative for worktree portability; external paths stay absolute. */
export function portableRunnerSkillPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : path;
}

/** Only a list response uses relative paths; the catalog retains the runner's native paths. */
export function portableRunnerSkillList(list: RunnerSkillList, cwd: string): RunnerSkillList {
  return { ...list, skills: list.skills.map(skill => skill.path ? { ...skill, path: portableRunnerSkillPath(skill.path, cwd) } : skill) };
}
