import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, readTestEnv, servedRoot } from './agent-browser'
import { refreshMockSkills, writeMockSkills } from './runner-skills-fixture'

let browser: AgentBrowser
let baseUrl: string
let restore: (() => void) | undefined
beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  restore = writeMockSkills(servedRoot(), [
    { id: 'plugin:check', name: 'Check', description: 'Check the project', scope: 'repo', plugin: 'plugin', path: '/tmp/skill-list-probe/repo/.agents/check/SKILL.md' },
    { id: 'plugin:check', name: 'Check', description: 'User copy', scope: 'user', path: '/home/probe/skills/check/SKILL.md' },
  ], [{ message: 'Invalid skill manifest', path: '/broken/SKILL.md' }])
  await refreshMockSkills(baseUrl, 'codex')
  browser = AgentBrowser.open(`e2e-settings-skills-${process.pid}`)
  browser.setViewport(1440, 900)
})
afterAll(async () => {
  browser?.close()
  restore?.()
  if (baseUrl) await refreshMockSkills(baseUrl, 'codex')
})

describe('runner skill inventory against the native mock list', () => {
  it('shows duplicate ids with paths, metadata and runner problems, with no edit controls or body', () => {
    browser.goto(`${baseUrl}/skills`)
    browser.waitForFunction(`document.querySelector('select[aria-label="Runner"]') !== null`)
    browser.evaluate(`(() => { const select = document.querySelector('select[aria-label="Runner"]'); select.value = 'codex'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="skill-row"]').length === 2 && document.body.textContent.includes('Invalid skill manifest')`)
    expect(browser.count('[data-slot="skill-row"][data-skill="plugin:check"]')).toBe(2)
    expect(browser.count('[role="switch"]')).toBe(0)
    expect(browser.count('[data-slot="skill-body"]')).toBe(0)
    browser.click('[data-slot="skill-row"] summary')
    browser.waitForFunction(`document.querySelector('[data-slot="skill-row"][open]') !== null`)
    expect(browser.evaluate(`document.querySelector('[data-slot="skill-row"][open]').textContent`)).toContain('Plugin: plugin')
    expect(browser.evaluate(`document.querySelector('[data-slot="skill-row"][open]').textContent`)).toContain('.agents/check/SKILL.md')
  })
  it('re-reads the selected runner and retains the open entry', () => {
    browser.click('[data-slot="skills-refresh"]')
    browser.waitForFunction(`!document.querySelector('[data-slot="skills-refresh"]').disabled`)
    expect(browser.count('[data-slot="skill-row"][open]')).toBe(1)
    expect(browser.count('[data-slot="skill-row"]')).toBe(2)
  })
})
