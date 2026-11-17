import { describe, expect, it } from 'vitest';
import { portableRunnerSkillList, resolveRunnerSkill } from './runner-skill-reference.ts';
import type { RunnerSkill } from '@open-mercato/cezar-contract/runner-skills';

const context = { runner: 'codex' as const, account: 'work', cwd: '/task' };
const skill = (path: string, scope: RunnerSkill['scope'] = 'repo'): RunnerSkill => ({ id: 'review', name: 'Review', path, scope });
describe('native skill references', () => {
  it('selects a relative project path against the task worktree', () => {
    const entry = skill('/task/.agents/skills/review/SKILL.md');
    expect(resolveRunnerSkill([entry], { id: 'review', path: '.agents/skills/review/SKILL.md' }, context)).toEqual({ skill: entry });
    expect(portableRunnerSkillList({ runner: 'codex', skills: [entry, skill('/user/review')], problems: [], source: 'live' }, '/task').skills.map(s => s.path))
      .toEqual(['.agents/skills/review/SKILL.md', '/user/review']);
  });
  it('uses repo over user over system for name-only references', () => {
    const project = skill('/task/review');
    expect(resolveRunnerSkill([skill('/user/review', 'user'), project, skill('/system/review', 'system')], { id: 'review' }, context)).toEqual({ skill: project });
  });
  it.each([
    [skill('/one'), skill('/two')],
    [skill('/one'), skill('/admin', 'other')],
  ])('names every path for ambiguous references', (...entries) => {
    const result = resolveRunnerSkill(entries, { id: 'review' }, context);
    expect(result.error).toContain('codex account "work"');
    expect(result.error).toContain('ambiguous');
    for (const entry of entries) expect(result.error).toContain(entry.path);
  });
  it.each([undefined, '/plugins/known'])('resolves a unique other-scope copy with path %s', path => {
    const entry: RunnerSkill = { id: 'plugin:known', name: 'Plugin skill', scope: 'other', ...(path ? { path } : {}) };
    expect(resolveRunnerSkill([entry], { id: entry.id }, context)).toEqual({ skill: entry });
  });
  it('never substitutes a copy for a missing selected path', () => {
    expect(resolveRunnerSkill([skill('/task/new')], { id: 'review', path: 'old' }, context).error).toContain('/task/old');
  });
  it('names close ids and listed paths for a missing id', () => {
    expect(resolveRunnerSkill([skill('/task/review')], { id: 'rev' }, context).error).toContain('review (/task/review)');
  });
});
