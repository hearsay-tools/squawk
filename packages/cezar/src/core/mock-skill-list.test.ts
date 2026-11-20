import { skillMockRunners } from './mock-skill-runners.testkit.ts';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os'; // test-home-read: compare mock metadata paths only; no home file is read or written.
import { describe, expect, it } from 'vitest';
import { mockSkillList } from '../../scripts/mock-skill-list.mjs';
import { captures } from '../../scripts/mock-skill-list-data.mjs';
import { skillListFixtures } from '../../scripts/mock-skill-fixtures.mjs';
it('replaces the recorded skill lists in each native reply shape', () => {
  const replies = skillListFixtures([{ id: 'only-check', name: 'Check', path: '/p/SKILL.md' }]);
  expect(replies.claude).toMatchObject({ response: { response: { skills: [{ name: 'only-check' }] } } });
  expect(replies.codex).toMatchObject({ result: { data: [{ skills: [{ name: 'only-check', path: '/p/SKILL.md' }] }] } });
  expect(replies.opencode).toEqual([{ name: 'only-check', description: '', location: '/p/SKILL.md' }]);
  expect(replies.pi).toMatchObject({ data: { commands: [{ name: 'skill:only-check', sourceInfo: { path: '/p/SKILL.md' } }] } });
  expect(replies.omp).toMatchObject({ skills: [{ name: 'only-check', filePath: '/p/SKILL.md', baseDir: '/p' }] });
  expect(JSON.stringify(replies)).not.toContain('probe-project');
});

describe('native mock skill paths', () => {
  it('ships a capture for every runner whose mock serves skills, and none for another', () => {
    expect(Object.keys(captures).sort()).toEqual(skillMockRunners().sort());
  });
  for (const runner of skillMockRunners()) it(`${runner}: packaged mock capture equals its real CLI fixture`, () => {
    expect(captures[runner]).toEqual(JSON.parse(readFileSync(new URL(`../runners/${runner}/__fixtures__/skill-list.json`, import.meta.url), 'utf8')));
  });
  for (const runner of skillMockRunners()) it(`${runner}: substitutes string values before wire serialization`, () => {
    const cwd = 'C:\\Users\\probe\\repo "quoted" $&\nfolder';
    const original = structuredClone(captures[runner]);
    const result = mockSkillList(runner, cwd);
    // The expected reply: the capture with each probe path swapped by plain split and join.
    const expected = JSON.parse(JSON.stringify(original), (_key, value) => typeof value === 'string'
      ? value.split('/tmp/skill-list-probe/repo').join(cwd).split('/home/probe').join(homedir()) : value); // test-home-read: compare mock metadata only.
    expect(result).toEqual(expected);
    expect(captures[runner]).toEqual(original);
  });
});

it('replaces only explicit native fixture metadata and falls back after it is removed', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeMockSkills } = await import('../../scripts/mock-skill-fixtures.mjs');
  const cwd = mkdtempSync(join(tmpdir(), 'mock-skills-'));
  try {
    const before = mockSkillList('codex', cwd);
    const restore = writeMockSkills(cwd, [{ id: 'plugin:check', name: 'Check', path: '/home/probe/check/SKILL.md' }]);
    expect(mockSkillList('codex', cwd)).toMatchObject({ result: { data: [{ skills: [expect.objectContaining({
      name: 'plugin:check', path: `${homedir()}/check/SKILL.md`, // test-home-read: compare mock metadata only.
    })] }] } });
    expect(mockSkillList('claude', cwd)).toMatchObject({ response: { response: { skills: [expect.objectContaining({ display_name: 'Check' })] } } });
    restore();
    expect(mockSkillList('codex', cwd)).toEqual(before);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
