import { captures } from './mock-skill-list-data.mjs';
import { homedir } from 'node:os';

// Native metadata captured from the installed CLIs, before these mock routes were added.
export function mockSkillList(runner, cwd = process.cwd()) {
  const capture = JSON.stringify(captures[runner]);
  return JSON.parse(capture.replaceAll('/tmp/skill-list-probe/repo', cwd).replaceAll('/home/probe', homedir()));
}
