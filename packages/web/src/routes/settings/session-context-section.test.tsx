import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { SessionContextFile, SessionContextPreview, SessionContextProblem } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { hasUnsentInput } from '@/lib/version-reload'
import { SessionContextSection } from './session-context-section'

/**
 * Settings → Session context (hearsay-tools/squawk#4308). The server contract is pinned in
 * `packages/cezar/src/server/session-context-api.test.ts`; this covers what the user sees:
 * loading, the empty state, problems, a refused save and the read-only file.
 */

const VALID = 'version: 1\nrules:\n  - id: brief\n    on: session_start\n    template: Hello\n'

interface FakeServer {
  file: SessionContextFile
  getStatus?: number
  previewStatus?: number | undefined
  /** Resolves the first GET when set: lets a case look at the page before the file arrives. */
  hold?: Promise<void>
  /** Resolves each PUT when set: lets a case type while a save is on its way. */
  holdPut?: Promise<void>
  puts: { content: string; version: string | null }[]
  previews: { content: string; role: string }[]
}

const fileOf = (over: Partial<SessionContextFile> = {}): SessionContextFile => ({
  path: '.ai/squawk/context.yaml', exists: true, content: VALID, version: 'v1', writable: true, readOnlyReason: null, ...over,
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
        if (server.previewStatus) return json({ error: 'context.yaml must be at most 262144 bytes' }, server.previewStatus)
        const problems = problemsOf(body.content as string)
        const preview: SessionContextPreview = {
          problems,
          blocks: [{ id: 'handoff', target: 'built-in', status: 'applied', bytes: 120, reason: null, sources: ['<handoff.path>'], text: '# Handoff', truncated: false }],
          usedBytes: 127,
          limitBytes: 65_536,
        }
        return json(preview)
      }
      if (url.endsWith('/session-context') && method === 'GET') {
        await server.hold
        return server.getStatus ? json({ error: 'disk on fire' }, server.getStatus) : json(server.file)
      }
      if (url.endsWith('/session-context') && method === 'PUT') {
        server.puts.push({ content: body.content as string, version: body.version ?? null })
        await server.holdPut
        if (body.version !== server.file.version) return json({ error: 'context.yaml changed on disk since you opened it.' }, 409)
        server.file = fileOf({ content: body.content as string, version: `v${server.puts.length + 1}` })
        return json(server.file)
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

const editor = () => screen.getByLabelText('context.yaml rules') as HTMLTextAreaElement
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
const type = (text: string) => fireEvent.change(editor(), { target: { value: text } })

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('SessionContextSection', () => {
  it('keeps the layout while the file loads, with no empty state first', async () => {
    let release!: () => void
    serve({ file: fileOf(), hold: new Promise<void>((resolve) => { release = resolve }), puts: [], previews: [] })
    renderSection()
    expect(screen.getByText('Handoff block')).toBeTruthy()
    expect(document.querySelector('[data-slot="session-context-loading"]')).toBeTruthy()
    expect(screen.queryByText('No project rules yet')).toBeNull()
    // Reduced motion: the skeleton stops pulsing (Tailwind compiles the class into the media query).
    for (const bone of document.querySelectorAll('[data-slot="skeleton"]')) expect(bone.classList).toContain('motion-reduce:animate-none')
    release()
    expect((await screen.findByLabelText('context.yaml rules') as HTMLTextAreaElement).value).toBe(VALID)
    expect(document.querySelector('[data-slot="session-context-loading"]')).toBeNull()
  })

  it('explains the handoff block when no file exists and adds the first rule', async () => {
    const server: FakeServer = { file: fileOf({ exists: false, content: '', version: null }), puts: [], previews: [] }
    serve(server)
    renderSection()
    expect(await screen.findByText('No project rules yet')).toBeTruthy()
    expect(screen.getByText(/Every session already starts with its handoff block/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add the first rule' }))
    expect(editor().value).toContain('id: new-rule')
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    await waitFor(() => expect(server.puts).toEqual([{ content: editor().value, version: null }]))
    expect(await screen.findByText('Saved .ai/squawk/context.yaml')).toBeTruthy()
  })

  it('lists problems with their lines, turns Save off and keeps the draft', async () => {
    serve({ file: fileOf(), puts: [], previews: [] })
    renderSection()
    await screen.findByLabelText('context.yaml rules')
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

  it('keeps the draft when the disk changed, shows the disk version and overwrites it on request', async () => {
    const server: FakeServer = { file: fileOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.yaml rules')
    server.file = fileOf({ content: 'version: 1\n# edited elsewhere\n', version: 'v-disk' })
    const mine = VALID.replace('Hello', 'Mine')
    type(mine)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    expect(await screen.findByText('Not saved: the file changed on disk')).toBeTruthy()
    expect(editor().value).toBe(mine)
    fireEvent.click(screen.getByRole('button', { name: 'Show the disk version' }))
    expect(((await screen.findByLabelText('context.yaml on disk')) as HTMLTextAreaElement).value).toBe('version: 1\n# edited elsewhere\n')
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite it' }))
    await waitFor(() => expect(server.puts.at(-1)).toEqual({ content: mine, version: 'v-disk' }))
    expect(await screen.findByText('Saved .ai/squawk/context.yaml')).toBeTruthy()
  })

  it('keeps what the user typed while a save was on its way', async () => {
    let release!: () => void
    const server: FakeServer = { file: fileOf(), holdPut: new Promise<void>((resolve) => { release = resolve }), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.yaml rules')
    const first = VALID.replace('Hello', 'First')
    type(first)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    await waitFor(() => expect(server.puts).toHaveLength(1))
    const later = VALID.replace('Hello', 'First and later')
    type(later)
    release()
    expect(await screen.findByText('Saved .ai/squawk/context.yaml')).toBeTruthy()
    expect(editor().value).toBe(later)
    expect(screen.getByText('Unsaved')).toBeTruthy()
  })

  it('keeps the draft when the disk version cannot be read after a refused save', async () => {
    const server: FakeServer = { file: fileOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.yaml rules')
    server.file = fileOf({ version: 'v-disk' })
    server.getStatus = 500
    const mine = VALID.replace('Hello', 'Mine')
    type(mine)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    expect(await screen.findByText('Not saved: the file changed on disk')).toBeTruthy()
    // The refetch fails; the page says so, and the editor and its draft stay.
    expect(await screen.findByText(/Could not read context.yaml again: disk on fire/, undefined, { timeout: 10_000 })).toBeTruthy() // bound: the query retries before it fails
    expect(editor().value).toBe(mine)
    expect(screen.queryByText('Session context did not load')).toBeNull()
  })

  it('says why the preview failed, keeps Save off and retries on request', async () => {
    const server: FakeServer = { file: fileOf(), puts: [], previews: [], previewStatus: 400 }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.yaml rules')
    type(VALID.replace('Hello', 'Big'))
    expect(await screen.findByText(/The preview failed: context.yaml must be at most 262144 bytes/)).toBeTruthy()
    expect(screen.queryByText('Checking…')).toBeNull()
    expect(saveButton().disabled).toBe(true)
    server.previewStatus = undefined
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(saveButton().disabled).toBe(false))
  })

  it('does not call a draft valid when checking it again fails', async () => {
    const server: FakeServer = { file: fileOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.yaml rules')
    type(VALID.replace('Hello', 'Mine'))
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    server.previewStatus = 400
    fireEvent.click(screen.getByRole('radio', { name: 'worker' }))
    expect(await screen.findByText('Not checked')).toBeTruthy()
    // Back to the role whose good answer is cached: the check runs again and fails.
    fireEvent.click(screen.getByRole('radio', { name: 'parent' }))
    await waitFor(() => expect(server.previews.filter((p) => p.role === 'parent').length).toBeGreaterThan(1))
    expect(await screen.findByText('Not checked')).toBeTruthy()
    expect(screen.queryByText('Valid')).toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it('saves over the version the draft started from, even after a background reload', async () => {
    const server: FakeServer = { file: fileOf(), puts: [], previews: [] }
    serve(server)
    const client = createQueryClient()
    renderSection(client)
    await screen.findByLabelText('context.yaml rules')
    const mine = VALID.replace('Hello', 'Mine')
    type(mine)
    // Someone else saves; a background reload brings their version while the draft stays.
    server.file = fileOf({ content: 'version: 1\n# theirs\n', version: 'v-theirs' })
    await act(() => client.invalidateQueries({ queryKey: queryKeys.sessionContext }))
    expect(editor().value).toBe(mine)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    expect(await screen.findByText('Not saved: the file changed on disk')).toBeTruthy()
    expect(server.puts).toEqual([{ content: mine, version: 'v1' }])
    expect(server.file.content).toBe('version: 1\n# theirs\n')
  })

  it('says what failed when the file does not load', async () => {
    serve({ file: fileOf(), getStatus: 500, puts: [], previews: [] })
    renderSection()
    expect(await screen.findByText('Session context did not load')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('shows a read-only file with its reason and no save', async () => {
    serve({ file: fileOf({ writable: false, readOnlyReason: 'Cannot write read-only project data.' }), puts: [], previews: [] })
    renderSection()
    expect((await screen.findByLabelText('context.yaml rules')).hasAttribute('readonly')).toBe(true)
    expect(screen.getByText(/Cannot write read-only project data/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add rule/ })).toBeNull()
  })

  it('previews as a worker on request and inserts a variable at the caret', async () => {
    const server: FakeServer = { file: fileOf(), puts: [], previews: [] }
    serve(server)
    renderSection()
    await screen.findByLabelText('context.yaml rules')
    fireEvent.click(screen.getByRole('radio', { name: 'worker' }))
    await waitFor(() => expect(server.previews.at(-1)?.role).toBe('worker'))
    const at = VALID.indexOf('Hello')
    editor().setSelectionRange(at, at + 'Hello'.length)
    fireEvent.click(screen.getByRole('button', { name: '{{run.id}}' }))
    expect(editor().value).toBe(VALID.replace('Hello', '{{run.id}}'))
  })
})
