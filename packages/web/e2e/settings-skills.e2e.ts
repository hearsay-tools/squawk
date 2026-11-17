import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { AgentBrowser, readTestEnv, servedRoot } from './agent-browser'
import { refreshMockSkills, writeMockSkills } from './runner-skills-fixture'
import { clickInView } from './visual-ready'

const repoSkillPath = '/tmp/skill-list-probe/repo/.agents/check/SKILL.md'
const repoSkillRow = `[data-slot="skill-row"][data-skill="plugin:check"][data-skill-path=${JSON.stringify(join('.agents', 'check', 'SKILL.md'))}]`

let browser: AgentBrowser
let baseUrl: string
let restore: (() => void) | undefined
beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  restore = writeMockSkills(servedRoot(), [
    { id: 'plugin:check', name: 'Check', description: 'Check the project', scope: 'repo', plugin: 'plugin', path: repoSkillPath },
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
  function openInventory() {
    browser.goto(`${baseUrl}/skills`)
    const codex = `[role="group"][aria-label="Runner"] button:nth-child(2)`
    browser.waitForFunction(`document.querySelector(${JSON.stringify(codex)})?.textContent === 'Codex'`)
    browser.click(codex)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="skill-row"]').length === 2 && document.body.textContent.includes('Invalid skill manifest')`)
    expect(browser.count(repoSkillRow)).toBe(1)
  }
  it('shows duplicate ids with paths, metadata and runner problems, with no edit controls or body', () => {
    openInventory()
    expect(browser.count('[data-slot="skill-row"][data-skill="plugin:check"]')).toBe(2)
    expect(browser.count('[role="switch"]')).toBe(0)
    expect(browser.count('[data-slot="skill-body"]')).toBe(0)
    clickInView(browser, `${repoSkillRow} summary`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(repoSkillRow)})?.open === true`)
    expect(browser.evaluate(`document.querySelector('[data-slot="skill-row"][open]').textContent`)).toContain('Plugin plugin')
    expect(browser.evaluate(`document.querySelector('[data-slot="skill-row"][open]').textContent`)).toContain('.agents/check/SKILL.md')
  })
  it('re-reads the selected runner and retains the open entry', () => {
    openInventory()
    clickInView(browser, `${repoSkillRow} summary`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(repoSkillRow)})?.open === true`)
    browser.click('[data-slot="skills-refresh"]')
    browser.waitForFunction(`!document.querySelector('[data-slot="skills-refresh"]').disabled`)
    expect(browser.count('[data-slot="skill-row"][open]')).toBe(1)
    expect(browser.count(`${repoSkillRow}[open]`)).toBe(1)
    expect(browser.count('[data-slot="skill-row"]')).toBe(2)
  })
})
