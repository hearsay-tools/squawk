import { expect, it } from 'vitest'
import { groupRunnerSkills, shortSkillName } from './skills-list'

const skill = (id: string, extra: object = {}) => ({ id, name: id, ...extra })

it('orders project, user, plugins by name, built in, then other', () => {
  const groups = groupRunnerSkills([
    skill('x', { scope: 'system' }), skill('b:one', { plugin: 'b@market', scope: 'user' }), skill('loose'),
    skill('a:two', { plugin: 'a' }), skill('mine', { scope: 'user' }), skill('here', { scope: 'repo' }),
  ])
  expect(groups.map((group) => group.label)).toEqual(['This project', 'Your skills', 'a', 'b', 'Built in', 'Other'])
})

it('drops only the plugin prefix the group header already shows', () => {
  expect(shortSkillName(skill('sdlc:dev-flow', { plugin: 'sdlc@market' }))).toBe('dev-flow')
  expect(shortSkillName(skill('dev-flow', { plugin: 'sdlc' }))).toBe('dev-flow')
  expect(shortSkillName(skill('other:dev-flow', { plugin: 'sdlc' }))).toBe('other:dev-flow')
  expect(shortSkillName(skill('sdlc:', { plugin: 'sdlc' }))).toBe('sdlc:')
})
