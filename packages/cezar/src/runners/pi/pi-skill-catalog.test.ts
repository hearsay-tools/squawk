import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePiSkills } from './pi-skill-catalog.ts';
const capture = JSON.parse(readFileSync(new URL('./__fixtures__/skill-list.json', import.meta.url), 'utf8'));
const cwd = '/tmp/skill-list-probe/repo';
describe('pi native skill metadata', () => {
  it('maps the real recorded response without skill bodies', () => {
    const result = parsePiSkills(capture.data, cwd);
    expect(result.skills[0]).toMatchObject({ id: 'probe-project', scope: 'repo' });
    expect(result.skills).toHaveLength(3);
    expect(result.skills.some(s => s.plugin)).toBe(true);
    expect(result.skills.some(s => 'content' in s || 'body' in s)).toBe(false);
  });
  it('rejects malformed lists', () => {
    expect(() => parsePiSkills(null, cwd)).toThrow();
  });
});
