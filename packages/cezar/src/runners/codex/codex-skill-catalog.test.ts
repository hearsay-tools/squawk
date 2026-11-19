import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCodexSkills } from './codex-skill-catalog.ts';
const capture = JSON.parse(readFileSync(new URL('./__fixtures__/skill-list.json', import.meta.url), 'utf8'));
const cwd = '/tmp/skill-list-probe/repo';
describe('codex native skill metadata', () => {
  it('maps the real recorded response without skill bodies', () => {
    const result = parseCodexSkills(capture.result, cwd);
    expect(result.skills[0]).toMatchObject({ id: 'probe-project', scope: 'repo' });
    expect(result.skills).toHaveLength(3);
    expect(result.skills.some(s => s.plugin)).toBe(true);
    expect(result.skills.some(s => 'content' in s || 'body' in s)).toBe(false);
  });
  it('rejects malformed lists', () => {
    expect(() => parseCodexSkills(null, cwd)).toThrow();
  });
});
it('preserves duplicate names with distinct paths and maps admin scope', () => {
  const input = structuredClone(capture.result);
  input.data[0].skills.push({ ...input.data[0].skills[0], path: '/other/SKILL.md', scope: 'admin' });
  const result = parseCodexSkills(input, cwd);
  expect(result.skills.filter(s => s.id === 'probe-project')).toHaveLength(2);
  expect(result.skills.at(-1)).toMatchObject({ path: '/other/SKILL.md', scope: 'other' });
  expect(result.problems[0]?.message).toContain('frontmatter');
});
