export { writeMockSkills } from '../../cezar/scripts/mock-skill-fixtures.mjs'

export async function refreshMockSkills(baseUrl: string, runner = 'claude') {
  const response = await fetch(`${baseUrl}/api/v1/runner-skills?runner=${runner}&refresh=1`)
  if (!response.ok) throw new Error(`Runner skill fixture refresh failed: ${response.status}`)
}
