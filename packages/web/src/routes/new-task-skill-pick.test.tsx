import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ACCOUNTS, PROVIDERS_MULTI, pillReady, postedBody, renderNewTask, requests, serve, startTask, textarea } from './new-task.testkit'
import { resetToasts } from '@/components/ui/toaster'
import { readDraft, resetDraft, writeDraft } from './new-task-draft'

beforeEach(() => {
  resetDraft()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { act(() => resetToasts()); cleanup(); resetDraft(); vi.unstubAllGlobals() })

it('keeps same-name pathless skill rows distinct for keyboard selection', async () => {
  serve({ skills: [
    { id: 'first:check', name: 'Check' }, { id: 'second:check', name: 'Check' },
  ] })
  renderNewTask()
  await pillReady()
  fireEvent.click(screen.getByRole('button', { name: 'Choose a skill or workflow' }))
  const input = await screen.findByPlaceholderText('search skills & workflows…')
  fireEvent.change(input, { target: { value: 'Check' } })
  const options = document.querySelectorAll('[data-source-kind="skill"][data-slot="source-option"]')
  expect(options).toHaveLength(2)
  expect(options[0]?.getAttribute('data-value')).not.toBe(options[1]?.getAttribute('data-value'))
  fireEvent.keyDown(input, { key: 'End' })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(readDraft().source).toEqual({ source: 'skill', ref: 'second:check' }))
})

it.each(['', 'Saved task text'])('preserves draft text for a stale-path link without a ref: %s', async (text) => {
  writeDraft({ ...readDraft(), text })
  serve({ skills: [{ id: 'plugin:check', name: 'Check', path: 'current/SKILL.md' }] })
  renderNewTask('/new?skill=plugin%3Acheck&skillPath=gone%2FSKILL.md')
  await screen.findByText(/Unknown skill/)
  await pillReady()
  expect(textarea().value).toBe(text)
  expect(readDraft().text).toBe(text)
  expect(JSON.parse(localStorage.getItem('cez-new-task-draft')!).text).toBe(text)
  expect(readDraft().source).toEqual({ source: 'skill', ref: 'plugin:check', path: 'gone/SKILL.md' })
})

it('warns and preserves the linked intent for a stale-path link with a ref', async () => {
  writeDraft({ ...readDraft(), text: 'Saved task text' })
  serve({ skills: [{ id: 'plugin:check', name: 'Check', path: 'current/SKILL.md' }] })
  renderNewTask('/new?skill=plugin%3Acheck&skillPath=gone%2FSKILL.md&ref=Review')
  await screen.findByText(/Unknown skill/)
  await pillReady()
  expect(readDraft().source).toBeNull()
  expect(textarea().value).toBe('Use the "plugin:check" skill on: Review')
  expect(readDraft().text).toBe(textarea().value)
})

it.each([true, false])('waits for account settlement only for explicit account drafts: %s', async (explicit) => {
  serve()
  writeDraft({ ...readDraft(), agentProfile: explicit ? 'work' : null })
  const fallback = globalThis.fetch
  let release!: (response: Response) => void
  const profiles = new Promise<Response>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/workspace/agent-profiles') ? profiles : fallback(input, init))
  renderNewTask()
  await pillReady()
  fireEvent.change(textarea(), { target: { value: 'Review changes' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
  if (explicit) {
    await screen.findByText(/Still loading agent accounts/)
    expect(postedBody()).toBeUndefined()
  } else {
    await waitFor(() => expect(postedBody()).toBeDefined())
  }
  await act(async () => { release(new Response(JSON.stringify({ ...ACCOUNTS, profiles: [{ ...ACCOUNTS.profiles[1]!, id: 'work' }] }), { headers: { 'content-type': 'application/json' } })) })
  if (explicit) {
    await waitFor(() => expect(requests.some((request) => request.url.includes('account=work'))).toBe(true))
    await startTask()
    expect(postedBody()).toMatchObject({ agentProfile: 'work' })
  }
})

it('shows both copies of a recent plugin id, sends its chosen path and persists only the id in ui-state', async () => {
  writeDraft({ ...readDraft(), source: { source: 'skill', ref: 'plugin:check' } })
  serve({ skills: [
    { id: 'plugin:check', name: 'Check', description: 'Repo copy', path: '.agents/check/SKILL.md', scope: 'repo' },
    { id: 'plugin:check', name: 'Check', description: 'User copy', path: '/home/u/check/SKILL.md', scope: 'user' },
  ], uiState: { recentSources: [{ source: 'skill', ref: 'plugin:check' }], skillUsage: { 'plugin:check': 3 } } })
  renderNewTask()
  await pillReady('Check')
  fireEvent.click(screen.getByRole('button', { name: 'Choose a skill or workflow' }))
  await screen.findByText('Repo copy')
  fireEvent.change(screen.getByPlaceholderText('search skills & workflows…'), { target: { value: 'plugin:check' } })
  const choices = document.querySelectorAll('[data-source-kind="skill"][data-slot="source-option"]')
  expect(choices).toHaveLength(2)
  expect(choices[0]?.textContent).toContain('.agents/check/SKILL.md')
  expect(choices[1]?.textContent).toContain('/home/u/check/SKILL.md')
  fireEvent.click(choices[1]!)
  expect(readDraft().source).toEqual({ source: 'skill', ref: 'plugin:check', path: '/home/u/check/SKILL.md' })
  fireEvent.change(textarea(), { target: { value: 'Check this change' } })
  await startTask()
  expect(postedBody()).toMatchObject({ steps: [{ skill: 'plugin:check', skillPath: '/home/u/check/SKILL.md' }] })
  await waitFor(() => expect(requests.some((request) => request.method === 'PUT' && request.url === '/api/v1/ui-state')).toBe(true))
  const saved = requests.find((request) => request.method === 'PUT' && request.url === '/api/v1/ui-state')?.body
  expect(saved).toMatchObject({ lastTask: { source: 'skill', ref: 'plugin:check' }, recentSources: [{ source: 'skill', ref: 'plugin:check' }] })
  expect(JSON.stringify(saved)).not.toContain('SKILL.md')
})

it.each(['claude', 'codex'] as const)('uses a palette link identity instead of a saved %s runner and non-default account', async (runner) => {
  serve({ providerStatus: PROVIDERS_MULTI, skills: [
    { id: 'plugin:check', name: 'Check', description: 'Default checks', path: 'repo/SKILL.md' },
  ], agentProfiles: { ...ACCOUNTS, profiles: [{ ...ACCOUNTS.profiles[1]!, provider: runner, id: 'work' }] } })
  writeDraft({ ...readDraft(), runner, agentProfile: 'work', model: 'remembered-model', effort: 'high' })
  renderNewTask('/new?skill=plugin%3Acheck&skillPath=repo%2FSKILL.md&runner=claude')
  await pillReady('Check')
  expect(readDraft()).toMatchObject({ runner: 'claude', agentProfile: null,
    source: { source: 'skill', ref: 'plugin:check', path: 'repo/SKILL.md' } })
  if (runner === 'codex') expect(readDraft()).toMatchObject({ model: null, effort: null })
  fireEvent.change(textarea(), { target: { value: 'Check changes' } })
  await startTask()
  expect(postedBody()).toMatchObject({ runner: 'claude', steps: [{ skill: 'plugin:check', skillPath: 'repo/SKILL.md' }] })
  expect(postedBody()).not.toHaveProperty('agentProfile')
})

it('waits for account discovery before checking a deep link against the drafted runner', async () => {
  serve({ providerStatus: PROVIDERS_MULTI })
  writeDraft({ ...readDraft(), runner: 'codex', agentProfile: 'work' })
  const fallback = globalThis.fetch
  let release!: (response: Response) => void
  const profiles = new Promise<Response>((resolve) => { release = resolve })
  const nativeRequests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/workspace/agent-profiles')) return profiles
    if (url.includes('/runner-skills?')) {
      nativeRequests.push(url)
      const skills = url.includes('account=work') ? [{ id: 'plugin:check', name: 'Check', description: 'Work checks' }] : []
      return new Response(JSON.stringify({ runner: 'codex', skills, problems: [], source: 'live' }), { headers: { 'content-type': 'application/json' } })
    }
    return fallback(input, init)
  }))
  renderNewTask('/new?skill=plugin%3Acheck&ref=Review')
  await waitFor(() => expect(nativeRequests).toContain('/api/v1/runner-skills?runner=codex'))
  expect(screen.queryByText(/Unknown skill/)).toBeNull()
  await act(async () => { release(new Response(JSON.stringify({ profiles: [{ provider: 'codex', id: 'work', label: 'Work' }], selections: {} }), { headers: { 'content-type': 'application/json' } })) })
  await waitFor(() => expect(nativeRequests).toContain('/api/v1/runner-skills?runner=codex&account=work'))
  await waitFor(() => expect(document.querySelector('[data-slot="source-pill"]')?.textContent).toContain('Check'))
  expect(readDraft().source).toEqual({ source: 'skill', ref: 'plugin:check' })
})

it('marks the source menu busy until the runner skills arrive', async () => {
  serve({ skills: [{ id: 'spec-writer', name: 'spec-writer', scope: 'repo' }] })
  const fallback = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/runner-skills?')) await held
    return fallback(input, init)
  })
  renderNewTask()
  await pillReady()
  fireEvent.click(screen.getByRole('button', { name: 'Choose a skill or workflow' }))
  await screen.findByPlaceholderText('search skills & workflows…')
  const menu = document.querySelector<HTMLElement>('[data-slot="source-menu"]')!
  expect(menu.getAttribute('aria-busy')).toBe('true')
  expect(document.querySelector('[data-slot="source-skills-loading"]')?.textContent).toBe('Loading skills…')
  expect(document.querySelector('[data-source-kind="skill"][data-slot="source-option"]')).toBeNull()
  fireEvent.change(screen.getByPlaceholderText('search skills & workflows…'), { target: { value: 'zzz' } })
  expect(screen.queryByText('Nothing matches.')).toBeNull()
  fireEvent.change(screen.getByPlaceholderText('search skills & workflows…'), { target: { value: '' } })
  await act(async () => { release() })
  await waitFor(() => expect(menu.getAttribute('aria-busy')).toBe('false'))
  expect(document.querySelector('[data-slot="source-skills-loading"]')).toBeNull()
  expect(document.querySelector('[data-source-kind="skill"][data-slot="source-option"][data-source-ref="spec-writer"]')).not.toBeNull()
})
