import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClaudeSkills } from './claude-skill-catalog.ts';
const capture = JSON.parse(readFileSync(new URL('./__fixtures__/claude/skill-list.json', import.meta.url), 'utf8'));
describe('claude native skill metadata', () => {
  it('maps the real recorded response without skill bodies', () => {
    const result = parseClaudeSkills(capture.response.response);
    expect(result.skills[0]).toMatchObject({ id: 'probe-project', scope: 'repo' });
    expect(result.skills).toHaveLength(3);
    expect(result.skills.some(s => s.plugin)).toBe(true);
    expect(result.skills.some(s => 'content' in s || 'body' in s)).toBe(false);
  });
  it('rejects malformed lists', () => {
    expect(() => parseClaudeSkills(null)).toThrow();
  });
});
