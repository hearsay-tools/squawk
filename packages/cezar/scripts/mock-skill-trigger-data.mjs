import { runnerSkillData } from './mock-skill-data.mjs';

// Native captures from runners/<id>/__fixtures__/skill-trigger.json. See slice2-evidence.md.
export const captures = Object.fromEntries(Object.entries(runnerSkillData).map(([id, data]) => [id, data.skillTrigger]));
