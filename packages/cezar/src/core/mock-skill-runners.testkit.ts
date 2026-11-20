import { readFileSync } from 'node:fs';
import './register-all-runners.testkit.ts';
import { registeredRunners } from './runner-registry.ts';

/**
 * The registered runners whose mock script serves native skill replies: the script imports
 * `scripts/mock-skill-trigger.mjs`. Each of them owns `scripts/mock-skill-data/<id>.mjs`; a
 * runner whose mock never serves a skill needs none. Read from each definition's `mock.script`,
 * so a new runner joins by its mock script alone.
 */
export function skillMockRunners(): string[] {
  return registeredRunners()
    .filter(({ mock }) => readFileSync(new URL(`../../scripts/${mock.script}`, import.meta.url), 'utf8').includes("'./mock-skill-trigger.mjs'"))
    .map(({ id }) => id);
}
