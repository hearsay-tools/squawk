import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { captures } from './mock-skill-list-data.mjs';

export const MOCK_SKILLS_FILE = '.mock-runner-skills.json';

/** Tests replace metadata inside recorded native replies, never read skill Markdown. */
export function skillListFixtures(skills, problems = []) {
  const replies = structuredClone(captures);
  replies.claude.response.response.skills = skills.map(skill => ({
    ...captures.claude.response.response.skills[0], name: skill.id ?? skill.name,
    display_name: skill.name, description: skill.description ?? '',
    source: skill.scope === 'user' ? 'user' : skill.plugin ? 'plugin' : 'project',
  }));
  replies.codex.result.data[0].skills = skills.map(skill => ({
    ...captures.codex.result.data[0].skills[0], name: skill.id ?? skill.name,
    description: skill.description ?? '', scope: skill.scope ?? 'repo', pluginId: skill.plugin ?? null,
    path: skill.path ?? `/tmp/skill-list-probe/repo/.agents/skills/${skill.id ?? skill.name}/SKILL.md`,
  }));
  replies.codex.result.data[0].errors = problems;
  return replies;
}

export function writeMockSkills(root, skills, problems = []) {
  const path = join(root, MOCK_SKILLS_FILE);
  let previous;
  try { previous = readFileSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeFileSync(path, JSON.stringify(skillListFixtures(skills, problems)));
  return () => { if (previous) writeFileSync(path, previous); else rmSync(path, { force: true }); };
}
