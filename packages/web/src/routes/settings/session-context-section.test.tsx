import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type {
  SessionContextFile,
  SessionContextPreview,
  SessionContextProblem,
  SessionContextSharedFile,
  SessionContextState,
} from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { hasUnsentInput } from '@/lib/version-reload'
import { SessionContextSection } from './session-context-section'

/**
 * Settings → Session context (hearsay-tools/squawk#4308, hearsay-tools/squawk#4341). The server contract is pinned in
 * `packages/cezar/src/server/session-context-api.test.ts`; this covers what the user sees:
 * loading, empty shared/local states, Local vs. Shared tabs, combined preview, problems,
 * 409 conflict recovery, and read-only local/shared states.
 */

const VALID = 'version: 1\nrules:\n  - id: brief\n    on: session_start\n    template: Hello\n'
const SHARED_VALID = 'version: 1\nrules:\n  - id: vision\n    on: session_start\n    template: Shared vision\n'

interface FakeServer {
  state: SessionContextState
  getStatus?: number
  previewStatus?: number | undefined
  /** Resolves the first GET when set: lets a case look at the page before the files arrive. */
  hold?: Promise<void>
  /** Resolves each PUT when set: lets a case type while a save is on its way. */
  holdPut?: Promise<void>
  puts: { content: string; version: string | null }[]
  previews: { content: string; role: string }[]
}

const localOf = (over: Partial<SessionContextFile> = {}): SessionContextFile => ({
  path: '.ai/squawk/context.local.yaml', exists: true, content: VALID, version: 'v1', writable: true, readOnlyReason: null, ...over,
})

const sharedOf = (over: Partial<SessionContextSharedFile> = {}): SessionContextSharedFile => ({
  path: '.ai/squawk/context.yaml', exists: true, content: SHARED_VALID, tracked: true, unreadableReason: null, ...over,
})

const stateOf = (over: { local?: Partial<SessionContextFile>; shared?: Partial<SessionContextSharedFile> } = {}): SessionContextState => ({
  local: localOf(over.local),
  shared: sharedOf(over.shared),
})

/** The fake parser: a `handoff` id is the one problem it knows, on the line that names it. */
function problemsOf(content: string): SessionContextProblem[] {
  const line = content.split('\n').findIndex((l) => /id: handoff\b/.test(l))
  return line === -1 ? [] : [{ line: line + 1, rule: 1, message: 'id "handoff" is reserved for the built-in handoff block' }]
}

function serve(server: FakeServer) {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string | null>) : {}
      if (url.endsWith('/session-context/preview')) {
        server.previews.push({ content: body.content as string, role: body.role as string })
        if (server.previewStatus) return json({ error: 'context.local.yaml must be at most 262144 bytes' }, server.previewStatus)
        const problems = problemsOf(body.content as string)
        const overridesVision = /id: vision\b/.test(body.content as string)
        const blocks: SessionContextPreview['blocks'] = [
          { id: 'handoff', source: 'built-in', target: 'built-in', status: 'applied', overridesShared: false, bytes: 120, reason: null, sources: ['<handoff.path>'], text: '# Handoff', truncated: false },
        ]
        if (server.state.shared.exists) {
          blocks.push(
            overridesVision
              ? { id: 'vision', source: 'local', target: 'both', status: 'applied', overridesShared: true, bytes: 96, reason: 'overrides context.yaml', sources: [], text: 'Local vision', truncated: false }
              : { id: 'vision', source: 'shared', target: 'both', status: 'applied', overridesShared: false, bytes: 80, reason: null, sources: [], text: 'Shared vision', truncated: false },
          )
        }
        if ((body.content as string).includes('id: brief')) {
          blocks.push({ id: 'brief', source: 'local', target: 'both', status: 'applied', overridesShared: false, bytes: 64, reason: null, sources: [], text: 'Hello', truncated: false })
        }
        const preview: SessionContextPreview = { problems, blocks, usedBytes: 264, limitBytes: 65_536 }
        return json(preview)
      }
      if (url.endsWith('/session-context') && method === 'GET') {
        await server.hold
        return server.getStatus ? json({ error: 'disk on fire' }, server.getStatus) : json(server.state)
      }
      if (url.endsWith('/session-context') && method === 'PUT') {
        server.puts.push({ content: body.content as string, version: body.version ?? null })
        await server.holdPut
        if (body.version !== server.state.local.version) return json({ error: 'context.local.yaml changed on disk since you opened it.' }, 409)
        server.state = {
          ...server.state,
          local: localOf({ content: body.content as string, version: `v${server.puts.length + 1}` }),
        }
        return json(server.state)
      }
      return json({ error: 'unexpected' }, 500)
    }),
  )
}

function renderSection(client = createQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <SessionContextSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

const editor = () => screen.getByLabelText('context.local.yaml rules') as HTMLTextAreaElement
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
const type = (text: string) => fireEvent.change(editor(), { target: { value: text } })

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('SessionContextSection', () => {
  it('keeps the layout while loading, with skeletons and no empty state flash', async () => {
    let release!: () => void
    serve({ state: stateOf(), hold: new Promise<void>((resolve) => { release = resolve }), puts: [], previews: [] })
    renderSection()
    expect(screen.getByText('Handoff block')).toBeTruthy()
    expect(document.querySelector('[data-slot="session-context-loading"]')).toBeTruthy()
    expect(screen.queryByText('No project rules yet')).toBeNull()
    // Reduced motion: the skeleton stops pulsing (Tailwind compiles the class into the media query).
    for (const bone of document.querySelectorAll('[data-slot="skeleton"]')) expect(bone.classList).toContain('motion-reduce:animate-none')
    release()
    expect((await screen.findByLabelText('context.local.yaml rules') as HTMLTextAreaElement).value).toBe(VALID)
    expect(document.querySelector('[data-slot="session-context-loading"]')).toBeNull()
  })

  it('explains shared vs. local scope when neither file exists and adds a local rule', async () => {
    const server: FakeServer = {
      state: stateOf({ local: { exists: false, content: '', version: null }, shared: { exists: false, content: '', tracked: false } }),
      puts: [],
      previews: [],
    }
    serve(server)
    renderSection()
    expect(await screen.findByText('No project rules yet')).toBeTruthy()
    expect(screen.getByText(/Commit shared team rules in \.ai\/squawk\/context\.yaml/)).toBeTruthy()
    expect(screen.getByText(/host-local rules in \.ai\/squawk\/context\.local\.yaml/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add a local rule' }))
    expect(editor().value).toContain('id: new-rule')
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    await waitFor(() => expect(server.puts).toEqual([{ content: editor().value, version: null }]))
    expect(await screen.findByText('Saved .ai/squawk/context.local.yaml')).toBeTruthy()
  })

  it('shows combined preview and read-only tracked shared context.yaml when only shared rules exist', async () => {
    const server: FakeServer = {
      state: stateOf({ local: { exists: false, content: '', version: null }, shared: { exists: true, content: SHARED_VALID, tracked: true } }),
      puts: [],
      previews: [],
    }
    serve(server)
    renderSection()
    expect(await screen.findByText(/No local rules yet/)).toBeTruthy()
    expect(await screen.findByText('Shared vision')).toBeTruthy()
    const sharedTab = screen.getByRole('tab', { name: /Shared/ })
    fireEvent.click(sharedTab)
    expect(screen.getByText('Tracked in Git')).toBeTruthy()
    expect(screen.getByText('Read only')).toBeTruthy()
    const sharedEditor = screen.getByLabelText('context.yaml shared rules') as HTMLTextAreaElement
    expect(sharedEditor.hasAttribute('readonly')).toBe(true)
    expect(sharedEditor.value).toBe(SHARED_VALID)
  })

  it('switches between Local and Shared tabs with arrow keys while keeping unsaved local drafts and combined preview', async () => {
    serve({ state: stateOf(), puts: [], previews: [] })
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    const override = 'version: 1\nrules:\n  - id: vision\n    on: session_start\n    template: Local vision\n'
    type(override)
    expect(await screen.findByText('local · overrides shared')).toBeTruthy()
    const localTab = screen.getByRole('tab', { name: /Local/ })
    const sharedTab = screen.getByRole('tab', { name: /Shared/ })
    expect([localTab.tabIndex, sharedTab.tabIndex]).toEqual([0, -1])
    fireEvent.keyDown(localTab, { key: 'ArrowRight' })
    expect(sharedTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(sharedTab)
    expect(screen.getByLabelText('context.yaml shared rules')).toBeTruthy()
    expect(hasUnsentInput()).toBe(true)
    fireEvent.keyDown(sharedTab, { key: 'ArrowLeft' })
    expect(editor().value).toBe(override)
  })

  it('lists problems with their lines, turns Save off and keeps the draft', async () => {
    serve({ state: stateOf(), puts: [], previews: [] })
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    const bad = VALID.replace('brief', 'handoff')
    type(bad)
    expect(await screen.findByText('1 problem: fix it to save')).toBeTruthy()
    expect(screen.getByText('id "handoff" is reserved for the built-in handoff block')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    expect(screen.getByText('Save is off while the file has problems.')).toBeTruthy()
    expect(document.querySelector('[data-slot="code-editor"] [data-marked]')?.textContent).toContain('id: handoff')
    fireEvent.click(screen.getByRole('button', { name: 'Line 3' }))
    expect(editor().value.slice(editor().selectionStart, editor().selectionEnd)).toBe('  - id: handoff')
    expect(editor().value).toBe(bad)
    expect(hasUnsentInput()).toBe(true)
  })

  it('keeps the draft when context.local.yaml changed on disk, shows the disk version and overwrites it on request', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    server.state = stateOf({ local: { content: 'version: 1\n# edited elsewhere\n', version: 'v-disk' } })
    const mine = VALID.replace('Hello', 'Mine')
    type(mine)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    expect(await screen.findByText('Not saved: the file changed on disk')).toBeTruthy()
    expect(editor().value).toBe(mine)
    fireEvent.click(screen.getByRole('button', { name: 'Show the disk version' }))
    expect(((await screen.findByLabelText('context.local.yaml on disk')) as HTMLTextAreaElement).value).toBe('version: 1\n# edited elsewhere\n')
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite it' }))
    await waitFor(() => expect(server.puts.at(-1)).toEqual({ content: mine, version: 'v-disk' }))
    expect(await screen.findByText('Saved .ai/squawk/context.local.yaml')).toBeTruthy()
  })

  it('keeps what the user typed while a save was on its way', async () => {
    let release!: () => void
    const server: FakeServer = { state: stateOf(), holdPut: new Promise<void>((resolve) => { release = resolve }), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    const first = VALID.replace('Hello', 'First')
    type(first)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    await waitFor(() => expect(server.puts).toHaveLength(1))
    const later = VALID.replace('Hello', 'First and later')
    type(later)
    release()
    expect(await screen.findByText('Saved .ai/squawk/context.local.yaml')).toBeTruthy()
    expect(editor().value).toBe(later)
    expect(screen.getByText('Unsaved')).toBeTruthy()
  })

  it('keeps the draft when the disk version cannot be read after a refused save', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    server.state = stateOf({ local: { version: 'v-disk' } })
    server.getStatus = 500
    const mine = VALID.replace('Hello', 'Mine')
    type(mine)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    expect(await screen.findByText('Not saved: the file changed on disk')).toBeTruthy()
    expect(await screen.findByText(/Could not read session context again: disk on fire/, undefined, { timeout: 10_000 })).toBeTruthy() // bound: the query retries before it fails
    expect(editor().value).toBe(mine)
    expect(screen.queryByText('Session context did not load')).toBeNull()
  })

  it('says why the preview failed, keeps Save off and retries on request', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [], previewStatus: 400 }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    type(VALID.replace('Hello', 'Big'))
    expect(await screen.findByText(/The preview failed: context.local.yaml must be at most 262144 bytes/)).toBeTruthy()
    expect(screen.queryByText('Checking…')).toBeNull()
    expect(saveButton().disabled).toBe(true)
    server.previewStatus = undefined
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(saveButton().disabled).toBe(false))
  })

  it('does not call a draft valid when checking it again fails', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    type(VALID.replace('Hello', 'Mine'))
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    server.previewStatus = 400
    fireEvent.click(screen.getByRole('radio', { name: 'worker' }))
    expect(await screen.findByText('Not checked')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'parent' }))
    await waitFor(() => expect(server.previews.filter((p) => p.role === 'parent').length).toBeGreaterThan(1))
    expect(await screen.findByText('Not checked')).toBeTruthy()
    expect(screen.queryByText('Valid')).toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it('saves over the version the draft started from, even after a background reload', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [] }
    serve(server)
    const client = createQueryClient()
    renderSection(client)
    await screen.findByLabelText('context.local.yaml rules')
    const mine = VALID.replace('Hello', 'Mine')
    type(mine)
    server.state = stateOf({ local: { content: 'version: 1\n# theirs\n', version: 'v-theirs' } })
    await act(() => client.invalidateQueries({ queryKey: queryKeys.sessionContext }))
    expect(editor().value).toBe(mine)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    expect(await screen.findByText('Not saved: the file changed on disk')).toBeTruthy()
    expect(server.puts).toEqual([{ content: mine, version: 'v1' }])
    expect(server.state.local.content).toBe('version: 1\n# theirs\n')
  })

  it('moves between Parent and Worker with the arrow keys, with one tab stop', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    const parent = screen.getByRole('radio', { name: 'parent' })
    const worker = screen.getByRole('radio', { name: 'worker' })
    expect([parent.tabIndex, worker.tabIndex]).toEqual([0, -1])
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    expect(worker.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(worker)
    expect([parent.tabIndex, worker.tabIndex]).toEqual([-1, 0])
    await waitFor(() => expect(server.previews.at(-1)?.role).toBe('worker'))
  })

  it('moves between the Edit and Preview tabs with the arrow keys', async () => {
    serve({ state: stateOf(), puts: [], previews: [] })
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    const edit = screen.getByRole('tab', { name: 'edit' })
    const preview = screen.getByRole('tab', { name: 'preview' })
    expect([edit.tabIndex, preview.tabIndex]).toEqual([0, -1])
    expect(edit.getAttribute('aria-controls')).toBeTruthy()
    fireEvent.keyDown(edit, { key: 'ArrowRight' })
    expect(preview.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(preview)
  })

  it('lets the reader scroll and focus a long preview block', async () => {
    serve({ state: stateOf(), puts: [], previews: [] })
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    const text = await screen.findByLabelText('handoff text')
    expect(text.tabIndex).toBe(0)
  })

  it('keeps the draft counted as unsent when the local file turns read only after a refused save', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    server.state = stateOf({ local: { version: null, content: '', writable: false, readOnlyReason: 'Squawk cannot edit it: it is not valid UTF-8.' } })
    type(VALID.replace('Hello', 'Mine'))
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    expect(await screen.findByText(/not valid UTF-8/)).toBeTruthy()
    expect(editor().value).toBe(VALID.replace('Hello', 'Mine'))
    expect(hasUnsentInput()).toBe(true)
  })

  it('says what failed when the state does not load', async () => {
    serve({ state: stateOf(), getStatus: 500, puts: [], previews: [] })
    renderSection()
    expect(await screen.findByText('Session context did not load')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('shows a read-only local file with its reason and no save', async () => {
    serve({ state: stateOf({ local: { writable: false, readOnlyReason: 'Cannot write read-only project data.' } }), puts: [], previews: [] })
    renderSection()
    expect((await screen.findByLabelText('context.local.yaml rules')).hasAttribute('readonly')).toBe(true)
    expect(screen.getByText(/Cannot write read-only project data/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add rule/ })).toBeNull()
  })

  it('previews as a worker on request and inserts a variable at the caret', async () => {
    const server: FakeServer = { state: stateOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.local.yaml rules')
    fireEvent.click(screen.getByRole('radio', { name: 'worker' }))
    await waitFor(() => expect(server.previews.at(-1)?.role).toBe('worker'))
    const at = VALID.indexOf('Hello')
    editor().setSelectionRange(at, at + 'Hello'.length)
    fireEvent.click(screen.getByRole('button', { name: '{{run.id}}' }))
    expect(editor().value).toBe(VALID.replace('Hello', '{{run.id}}'))
  })
})
