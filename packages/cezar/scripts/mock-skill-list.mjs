import { captures } from './mock-skill-list-data.mjs';
import { homedir } from 'node:os';

// Native metadata captured from the installed CLIs, before these mock routes were added.
export function mockSkillList(runner, cwd = process.cwd()) {
  return JSON.parse(JSON.stringify(captures[runner]), (_key, value) => typeof value === 'string'
    ? value.replaceAll('/tmp/skill-list-probe/repo', () => cwd).replaceAll('/home/probe', () => homedir()) : value);
}
