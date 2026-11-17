import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { useUiState } from '@/api/queries'
import { useSourceSelection } from './new-task-controller'
import { readDraft, resetDraft, writeDraft } from './new-task-draft'
import { buildAutomationTask, buildCreateRunBody, resolveSource, type DraftTaskSource } from './new-task-form'

const skills = [
  { id: 'plugin:check', name: 'Check', description: 'Runner description', path: '.agents/check/SKILL.md' },
  { id: 'plugin:check', name: 'Check', description: 'Second copy', path: '/home/u/check/SKILL.md' },
]
const picked: DraftTaskSource = { source: 'skill', ref: 'plugin:check', path: skills[0]!.path }
afterEach(() => { cleanup(); resetDraft(); vi.unstubAllGlobals() })

describe('state restore cases', () => {
  it('opens without a skill when there is no draft, whatever lastTask holds', () => {
    expect(resolveSource(readDraft().source, skills, [])).toBeNull()
  })
  it('restores the drafted id and path with the runner description', () => {
    writeDraft({ ...readDraft(), source: picked, runner: 'codex', agentProfile: 'work' })
    const restored = resolveSource(readDraft().source, skills, [])
    expect(restored).toEqual(picked)
    expect(skills.find((skill) => skill.path === (restored?.source === 'skill' ? restored.path : undefined))?.description).toBe('Runner description')
  })
  it('keeps separate project drafts and checks each against its own runner list', () => {
    writeDraft({ ...readDraft('a'), source: picked, runner: 'codex' }, 'a')
    const other = { source: 'skill', ref: 'ship' } as const
    writeDraft({ ...readDraft('b'), source: other, runner: 'pi' }, 'b')
    expect(resolveSource(readDraft('a').source, skills, [])).toEqual(picked)
    expect(resolveSource(readDraft('b').source, [{ id: 'ship', name: 'Ship' }], [])).toEqual(other)
  })
  it('masks a drafted skill on another runner or account and restores it on changing back', () => {
    writeDraft({ ...readDraft(), source: picked })
    expect(resolveSource(readDraft().source, [], [])).toBeNull()
    expect(readDraft().source).toEqual(picked)
    expect(resolveSource(readDraft().source, skills, [])).toEqual(picked)
  })
  it('keeps a gone path in the draft and never substitutes the other copy of its id', () => {
    writeDraft({ ...readDraft(), source: picked })
    expect(resolveSource(readDraft().source, [skills[1]!], [])).toBeNull()
    expect(readDraft().source).toEqual(picked)
  })
  it('shows a drafted id unchecked when the list is unavailable', () => {
    expect(resolveSource(picked, [], [], true)).toEqual(picked)
  })
  it('preserves typed unknown ids and keeps workflow selection unchanged', () => {
    const typed = { source: 'skill', ref: 'unknown', typed: true } as const
    expect(resolveSource(typed, [], [])).toEqual(typed)
    expect(resolveSource({ source: 'workflow', ref: 'ship' }, [], [{ name: 'ship', source: 'file', steps: [] }])).toEqual({ source: 'workflow', ref: 'ship' })
  })
})

it('sends the exact plugin id and chosen path only on the inline run step', () => {
  const body = buildCreateRunBody({ task: 'Check', source: picked, runner: 'codex', model: '', images: [] })
  expect(body.steps?.[0]).toMatchObject({ skill: 'plugin:check', skillPath: '.agents/check/SKILL.md' })
  expect(buildAutomationTask({ task: 'Check', source: picked, runner: 'codex', model: '', images: [] }).steps?.[0]).not.toHaveProperty('skillPath')
})

it.each(['unavailable', 'failed', 'live'])('reads the selected runner/account and keeps the form usable for a %s list', async (state) => {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = String(input)
    requests.push(url)
    const native = url.includes('/runner-skills')
    const body = native ? { runner: 'codex', skills: state === 'live' ? skills : [], problems: [], source: state === 'live' ? 'live' : 'unavailable' }
      : url.endsWith('/workflows') ? { workflows: [], issues: [] } : {}
    return new Response(JSON.stringify(body), { status: native && state === 'failed' ? 500 : 200, headers: { 'content-type': 'application/json' } })
  }))
  const client = createQueryClient()
  const { result } = renderHook(() => useSourceSelection(picked, useUiState(), 'codex', 'work'), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  await waitFor(() => expect(result.current.sourcesReady).toBe(true))
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex&account=work'))
  expect(result.current.source).toEqual(picked)
  if (state === 'live') await waitFor(() => expect(result.current.selectedSkill?.description).toBe('Runner description'))
  else expect(result.current.unchecked).toBe(true)
})
