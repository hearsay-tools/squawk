import { runnerSkillData } from './mock-skill-data.mjs';

// Metadata excerpts from runners/<id>/__fixtures__/skill-list.json. No skill bodies.
export const captures = Object.fromEntries(Object.entries(runnerSkillData).map(([id, data]) => [id, data.skillList]));
