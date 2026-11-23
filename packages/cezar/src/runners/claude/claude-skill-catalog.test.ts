import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverClaudeSkills, parseClaudeSkills } from './claude-skill-catalog.ts';
import { claudeRunner } from './definition.ts';
import { buildClaudeArgs } from './claude-cli-runner.ts';

// The catalog builds the Claude child env through the registry; every case drives Claude.

sealTestRunners(claudeRunner);
afterEach(() => vi.unstubAllEnvs());
const capture = JSON.parse(readFileSync(new URL('./__fixtures__/skill-list.json', import.meta.url), 'utf8'));
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

it.each(['HSQ', 'CEZ'])('%s user-only sources match the session argv', async prefix => {
  vi.stubEnv('HSQ_CLAUDE_SETTING_SOURCES', prefix === 'HSQ' ? 'user' : undefined);
  vi.stubEnv('CEZ_CLAUDE_SETTING_SOURCES', prefix === 'HSQ' ? 'project' : 'user');
  const session = buildClaudeArgs({ cwd: '/repo', userPrompt: '', toolGrant: { kind: 'unset' } });
  let probe: readonly string[] = [];
  await expect(discoverClaudeSkills({ cwd: '/repo', spawn: (_bin, args) => {
    probe = args;
    throw new Error('captured argv');
  } })).rejects.toThrow('captured argv');
  const flag = session.slice(session.indexOf('--setting-sources'), session.indexOf('--setting-sources') + 2);
  expect(flag).toEqual(['--setting-sources', 'user']);
  expect(probe).toContain('--setting-sources');
  expect(probe.slice(probe.indexOf('--setting-sources'), probe.indexOf('--setting-sources') + 2)).toEqual(flag);
});
