import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK_SKILLS_FILE } from './mock-skill-fixtures.mjs';
import { captures } from './mock-skill-list-data.mjs';
import { homedir } from 'node:os';

// Native metadata captured from the installed CLIs, before these mock routes were added.
export function mockSkillList(runner, cwd = process.cwd()) {
  let recording = captures[runner];
  try { recording = JSON.parse(readFileSync(join(cwd, MOCK_SKILLS_FILE), 'utf8'))[runner] ?? recording; }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  return JSON.parse(JSON.stringify(recording), (_key, value) => typeof value === 'string'
    ? value.replaceAll('/tmp/skill-list-probe/repo', () => cwd).replaceAll('/home/probe', () => homedir()) : value);
}
