import { readdirSync } from 'node:fs';

const DIRECTORY = new URL('./mock-skill-data/', import.meta.url);

/**
 * The native skill captures of every runner mock that ships one: `mock-skill-data/<id>.mjs`, which
 * exports `skillList` and `skillTrigger`. The mocks run as separate Node processes and cannot
 * import adapters or `runners/<id>/`, so a runner's captures sit next to its mock script. A new
 * runner adds a file; no list here changes.
 */
export const runnerSkillData = Object.fromEntries(await Promise.all(readdirSync(DIRECTORY)
  .filter(file => file.endsWith('.mjs')).sort()
  .map(async file => [file.slice(0, -'.mjs'.length), await import(new URL(file, DIRECTORY).href)])));
