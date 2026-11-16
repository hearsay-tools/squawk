import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOmpSkills } from './omp-skill-catalog.ts';
const capture = JSON.parse(readFileSync(new URL('./__fixtures__/omp/skill-list.json', import.meta.url), 'utf8'));
describe('omp native skill metadata', () => {
  it('maps the real recorded response without skill bodies', () => {
    const result = parseOmpSkills(capture);
    expect(result.skills[0]).toMatchObject({ id: 'probe-project', scope: 'repo' });
    expect(result.skills).toHaveLength(3);
    expect(result.skills.some(s => s.plugin)).toBe(true);
    expect(result.skills.some(s => 'content' in s || 'body' in s)).toBe(false);
  });
  it('rejects malformed lists', () => {
    expect(() => parseOmpSkills(null)).toThrow();
  });
});
