export interface MockSkill {
  id?: string
  name: string
  description?: string
  scope?: string
  plugin?: string
  path?: string
}
export declare const MOCK_SKILLS_FILE: string
export declare function skillListFixtures(skills: MockSkill[], problems?: { message: string; path?: string }[]): Record<string, unknown>
export declare function writeMockSkills(root: string, skills: MockSkill[], problems?: { message: string; path?: string }[]): () => void
