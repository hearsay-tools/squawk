import { productCommand } from '@/lib/product-name'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/api/queries'
import { seedRunners } from '@/test/runners.testkit'
import { createQueryClient } from '@/api/query-client'
import type { AgentConfigFile, AgentConfigListing } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { hasUnsentInput, trackTyping } from '@/lib/version-reload'
import { AgentConfigSection } from './agent-config-section'

/**
 * Settings → Agent config (#404, per-agent regrouping per spec
 * 2026-07-17-agent-config-by-agent): the SURFACE honoring the API contract
 * (pinned server-side in src/server/agent-config-api.test.ts). Covers the agent
 * selector, per-agent grouping (incl. shared files under every reader and the
 * MCP subsection with Claude's read-only user scopes), the vendor precedence
 * string, the read-only hosted render, and a save round-trip.
 */

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id' | 'label'>): AgentConfigFile {
  return {
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: false,
    precedence: 'Overrides user settings key by key.',
    docsUrl: 'https://code.claude.com/docs/en/settings',
    path: `/repo/${over.label}`,
    exists: true,
    size: 10,
    version: 'v1',
    writable: true,
    ...over,
  }
}

const HEALTH = {
  version: '0.0.0',
  repoRoot: '/repo',
  repo: null,
  checks: [{ name: 'claude', available: true }],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, settingsAdmin: true, remoteSettingsAdmin: false },
}

/** A remote cockpit whose host operator ran `cez remote-settings enable` (hearsay-tools/cezarion#2428). */
const REMOTE_ADMIN = { localHandoff: false, settingsAdmin: true, remoteSettingsAdmin: true }

function serve(listing: AgentConfigListing, fileContent = '{"a":1}', capabilities: object = HEALTH.capabilities) {
  let content = fileContent
  let version = 'v1'
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/v1/health')) return json({ ...HEALTH, capabilities })
      if (url.endsWith('/api/v1/agent-config')) return json(listing)
      if (url.includes('/api/v1/agent-config/') && method === 'GET') {
        return json({ id: 'x', path: '/repo/x', exists: true, content, version })
      }
      if (url.includes('/api/v1/agent-config/') && method === 'PUT') {
        const body = init?.body ? (JSON.parse(String(init.body)) as { content?: string }) : undefined
        content = body?.content ?? '{"a":2}'
        version = 'v2'
        return json({ id: 'x', path: '/repo/x', exists: true, content, version })
      }
      return json({ error: 'unexpected' }, 500)
    }),
  )
}

/** What the stubbed server answers right now; a case changes it to act as the host operator. */
interface LiveServer { capabilities: object; listing: AgentConfigListing; putStatus: number }

function serveLive(server: LiveServer) {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/v1/health')) return json({ ...HEALTH, capabilities: server.capabilities })
      if (url.endsWith('/api/v1/agent-config')) return json(server.listing)
      if (url.includes('/api/v1/agent-config/') && method === 'GET') {
        return json({ id: 'x', path: '/repo/x', exists: true, content: '{"a":1}', version: 'v1' })
      }
      if (url.includes('/api/v1/agent-config/') && method === 'PUT') {
        if (server.putStatus === 409) {
          return json({ error: `editing agent config is disabled on this remote cockpit — run \`${productCommand()} remote-settings enable\` on the host to allow it` }, 409)
        }
        return json({ id: 'x', path: '/repo/x', exists: true, content: '{"a":2}', version: 'v2' })
      }
      return json({ error: 'unexpected' }, 500)
    }),
  )
}

const READ_ONLY_REMOTE = { localHandoff: false, settingsAdmin: false, remoteSettingsAdmin: false }
const SETTINGS_FILE = fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })

function renderSection(client = seedRunners(createQueryClient())) {
  return render(
    <QueryClientProvider client={client}>
      <AgentConfigSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

function agentTab(agent: string): HTMLElement {
  const el = document.querySelector(`[data-slot="agent-config-agent"][data-agent="${agent}"]`)
  expect(el).toBeTruthy()
  return el as HTMLElement
}

/** The file list. A selected file's name shows in the editor too, so file lookups stay inside the list. */
function nav() {
  const el = document.querySelector('[data-slot="agent-config-nav"]')
  expect(el).toBeTruthy()
  return within(el as HTMLElement)
}

function findInNav(label: string): Promise<HTMLElement> {
  return waitFor(() => nav().getByText(label))
}

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentConfigSection', () => {
  it('lists each agent tab’s files and opens a selected file in the editor', async () => {
    serve({ editable: true, userMcp: null, files: [
      fileOf({ id: 'claude.memory', label: 'CLAUDE.md', kind: 'memory', format: 'markdown' }),
      fileOf({ id: 'claude.settings', label: '.claude/settings.json' }),
      fileOf({ id: 'claude.mcp', label: '.mcp.json', kind: 'mcp', holdsMcp: true }),
      fileOf({ id: 'claude.user', label: '~/.claude/settings.json', scope: 'user' }),
      fileOf({ id: 'codex.memory', label: 'AGENTS.md', runners: ['codex'], kind: 'memory' }),
    ] })
    renderSection()
    await waitFor(() => expect(agentTab('claude').getAttribute('role')).toBe('tab'))
    expect(nav().getByText('~/.claude/settings.json')).toBeTruthy()
    fireEvent.click(nav().getByText('.mcp.json'))
    await waitFor(() => expect(screen.getByLabelText('.mcp.json contents')).toBeTruthy())
    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(nav().getByText('AGENTS.md')).toBeTruthy())
    expect(nav().queryByText('.claude/settings.json')).toBeNull()
  })

  it('shows the full filename on its own line, with status on a subline below it', async () => {
    serve({ editable: true, userMcp: null, files: [
      fileOf({ id: 'claude.settings', label: '.claude/settings.local.json', exists: false }),
    ] })
    renderSection()
    const name = await findInNav('.claude/settings.local.json')
    expect(name.getAttribute('data-slot')).toBe('agent-config-file-name')
    expect(name.className).not.toContain('truncate')
    const button = name.closest('[data-slot="agent-config-file"]')!
    expect(button.querySelector('[data-slot="agent-config-file-meta"]')?.textContent).toContain('Not created')
  })

  it('renders the agent selector with a not-installed badge from health', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(agentTab('claude')).toBeTruthy())
    expect(agentTab('claude').getAttribute('data-selected')).toBe('true')
    // health only reports claude available — the other three carry the badge
    await waitFor(() => expect(agentTab('codex').textContent).toContain('not installed'))
    expect(agentTab('opencode').textContent).toContain('not installed')
    expect(agentTab('pi').textContent).toContain('not installed')
    expect(agentTab('claude').textContent).not.toContain('not installed')
  })

  it('Pi’s pane lists its files and states why the MCP group is empty and what to try', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'pi.user.settings', label: '~/.pi/agent/settings.json', runners: ['pi'], scope: 'user', tracked: 'outside-repo' }),
        fileOf({ id: 'pi.project.settings', label: '.pi/settings.json', runners: ['pi'] }),
        fileOf({ id: 'project.agents', label: 'AGENTS.md', runners: ['codex', 'opencode', 'pi'], kind: 'memory', format: 'markdown' }),
      ],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(agentTab('pi')).toBeTruthy())
    fireEvent.click(agentTab('pi'))
    await waitFor(() => expect(nav().getByText('.pi/settings.json')).toBeTruthy())
    expect(nav().getByText('~/.pi/agent/settings.json')).toBeTruthy()
    expect(nav().getByText('AGENTS.md')).toBeTruthy()
    const mcpGroup = document.querySelector('[data-slot="agent-config-group"][data-group="mcp"][data-agent="pi"]')!
    expect(mcpGroup).toBeTruthy()
    expect(mcpGroup.querySelector('[data-slot="agent-config-group-empty"]')).not.toBeNull()
    expect(mcpGroup.querySelectorAll('[data-slot="agent-config-file"]').length).toBe(0)
  })

  it('OMP’s pane lists its YAML settings and MCP files, labelled yaml, with no empty-state copy', async () => {
    serve(
      {
        editable: true,
        files: [
          fileOf({ id: 'omp.user.settings', label: '~/.omp/agent/config.yml', runners: ['omp'], scope: 'user', format: 'yaml', tracked: 'outside-repo' }),
          fileOf({ id: 'omp.project.mcp', label: '.omp/mcp.json', runners: ['omp'], kind: 'mcp', holdsMcp: true }),
        ],
        userMcp: null,
      },
      'retry:\n  enabled: true\n',
    )
    renderSection()
    await waitFor(() => expect(agentTab('omp')).toBeTruthy())
    fireEvent.click(agentTab('omp'))
    await waitFor(() => expect(nav().getByText('~/.omp/agent/config.yml')).toBeTruthy())
    expect(nav().getAllByText('.omp/mcp.json').length).toBeGreaterThan(0)
    fireEvent.click(nav().getByText('~/.omp/agent/config.yml'))
    await waitFor(() => expect(screen.getByLabelText('~/.omp/agent/config.yml contents')).toBeTruthy())
    expect(screen.getByText('yaml')).toBeTruthy()
    expect(document.querySelector('[data-slot="agent-config-group-empty"]')).toBeNull()
  })

  it('an empty group without empty-state copy still renders nothing (Claude’s MCP stays as it was)', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(nav().getByText('.claude/settings.json')).toBeTruthy())
    expect(document.querySelector('[data-slot="agent-config-group"][data-group="mcp"][data-agent="claude"]')).toBeNull()
  })

  it('shows only the selected agent’s files and swaps panes on switch', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
        fileOf({ id: 'codex.project.config', label: '.codex/config.toml', runners: ['codex'], format: 'toml', holdsMcp: true }),
      ],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(nav().getByText('.claude/settings.json')).toBeTruthy())
    expect(nav().queryByText('.codex/config.toml')).toBeNull()

    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(nav().getAllByText('.codex/config.toml').length).toBeGreaterThan(0))
    expect(nav().queryByText('.claude/settings.json')).toBeNull()
    // the config.toml holds Codex's MCP servers — it must appear under Settings AND MCP
    const groups = [...document.querySelectorAll('[data-slot="agent-config-group"]')].map((el) =>
      el.getAttribute('data-group'),
    )
    expect(groups).toContain('settings')
    expect(groups).toContain('mcp')
    expect(nav().getAllByText('.codex/config.toml').length).toBe(2)
  })

  it('a file read by several agents appears under every one of them (runners[], not runners[0])', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'project.agents', label: 'AGENTS.md', runners: ['codex', 'opencode'], kind: 'memory', format: 'markdown' })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(agentTab('codex')).toBeTruthy())
    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(nav().getAllByText('AGENTS.md')[0]).toBeTruthy())
    fireEvent.click(agentTab('opencode'))
    await waitFor(() => expect(nav().getAllByText('AGENTS.md')[0]).toBeTruthy())
  })

  it('Claude’s MCP group lists the user/local scopes read-only', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.mcp', label: '.mcp.json', kind: 'mcp', holdsMcp: true })],
      userMcp: { path: '~/.claude.json', servers: ['github', 'sentry'], readable: true },
    })
    renderSection()
    await waitFor(() => expect(nav().getByText('.mcp.json')).toBeTruthy())
    const block = document.querySelector('[data-slot="agent-config-user-mcp"]')!
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('github')
    expect(block.textContent).toContain('sentry')
    // the block belongs to Claude's pane only
    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config-user-mcp"]')).toBeNull())
  })

  it('a file selection never survives an agent switch', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
        fileOf({ id: 'opencode.project.config', label: 'opencode.json', runners: ['opencode'], holdsMcp: true }),
      ],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(nav().getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(nav().getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByLabelText('.claude/settings.json contents')).toBeTruthy())
    fireEvent.click(agentTab('opencode'))
    await waitFor(() => expect(screen.queryByLabelText('.claude/settings.json contents')).toBeNull())
  })

  it('opens the agent’s first file on load, with its vendor precedence, before any click', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.user.settings', label: '~/.claude/settings.json', scope: 'user', tracked: 'outside-repo' }),
        fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
        fileOf({ id: 'codex.project.config', label: '.codex/config.toml', runners: ['codex'], format: 'toml' }),
      ],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    expect(await screen.findByLabelText('~/.claude/settings.json contents')).toBeTruthy()
    expect(document.querySelector('[data-slot="agent-config-precedence"]')?.textContent).toBe('Overrides user settings key by key.')
    expect(document.querySelector('[data-slot="agent-config-editor-empty"]')).toBeNull()
    const selected = [...document.querySelectorAll('[data-slot="agent-config-file"][data-selected="true"]')]
    expect(selected.map((el) => el.getAttribute('title'))).toEqual(['~/.claude/settings.json'])
    // A pick stays; switching agent opens that agent's first file instead.
    fireEvent.click(nav().getByText('.claude/settings.json'))
    expect(await screen.findByLabelText('.claude/settings.json contents')).toBeTruthy()
    fireEvent.click(agentTab('codex'))
    expect(await screen.findByLabelText('.codex/config.toml contents')).toBeTruthy()
  })

  it('names Claude’s state file from the home folder, as ~/, with the whole command in one code span', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.user.settings', label: '~/.claude/settings.json', scope: 'user',
        path: '/tmp/run-1/server-home/.claude/settings.json', tracked: 'outside-repo' })],
      userMcp: { path: '/tmp/run-1/server-home/.claude.json', servers: [], readable: true },
    })
    renderSection()
    const path = await waitFor(() => {
      const el = document.querySelector('[data-slot="agent-config-user-mcp-path"]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(path.textContent).toBe('~/.claude.json')
    expect(path.getAttribute('title')).toBe('/tmp/run-1/server-home/.claude.json')
    expect(document.querySelector('[data-slot="agent-config-user-mcp-command"]')?.textContent).toBe('claude mcp add')
  })

  it('names a user-scope file in the scope line from the home folder, as ~/, with the full path on hover', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.user.settings', label: '~/.claude/settings.json', scope: 'user',
        path: '/tmp/run-1/server-home/.claude/settings.json', tracked: 'outside-repo' })],
      userMcp: null,
    })
    renderSection()
    const scope = await waitFor(() => {
      const el = document.querySelector('[data-slot="agent-config-scope"]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(scope.textContent).toBe('User scope · ~/.claude/settings.json')
    expect(scope.getAttribute('title')).toBe('/tmp/run-1/server-home/.claude/settings.json')
  })

  // hearsay-tools/squawk#3898: the panes come from the runners list, so its failure is shown, not a spinner.
  it('shows the runners query error instead of loading forever when the runners list fails', async () => {
    serve({ editable: true, userMcp: null, files: [fileOf({ id: 'claude.memory', label: 'CLAUDE.md', kind: 'memory', format: 'markdown' })] })
    const served = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (
      String(input).endsWith('/api/v1/runners')
        ? new Response(JSON.stringify({ error: 'no runners' }), { status: 404, headers: { 'content-type': 'application/json' } })
        : served(input, init)
    )))
    renderSection(createQueryClient())
    expect(await screen.findByText('Runners did not load')).toBeTruthy()
    expect(document.querySelector('[data-slot="agent-config-loading"]')).toBeNull()
  })

  it('renders read-only in hosted mode — no Save button', async () => {
    serve({
      editable: false,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json', writable: false })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText(/Read-only/)).toBeTruthy())
    fireEvent.click(nav().getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByLabelText('.claude/settings.json contents')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save file' })).toBeNull()
    expect(document.querySelector('[data-slot="agent-config-readonly"]')?.textContent).toContain(`${productCommand()} remote-settings enable`)
    expect(document.querySelector('[data-slot="remote-settings-notice"]')).toBeNull()
  })

  it('a remote cockpit with remote settings administration edits files and warns about host commands', async () => {
    serve(
      {
        editable: true,
        files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
        userMcp: { path: '~/.claude.json', servers: [], readable: true },
      },
      '{"a":1}',
      REMOTE_ADMIN,
    )
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="remote-settings-notice"]')).toBeTruthy())
    expect(document.querySelector('[data-slot="agent-config-readonly"]')).toBeNull()
    fireEvent.click(nav().getByText('.claude/settings.json'))
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeTruthy())
  })

  // hearsay-tools/cezarion#2428: the host grants and withdraws outside the cockpit, and a remote
  // cockpit gets no live health push, so the section must not trust a cached capability.
  it('opening the section re-reads a grant the host made after the cached read', async () => {
    const client = seedRunners(createQueryClient())
    client.setQueryData(queryKeys.health, { ...HEALTH, capabilities: READ_ONLY_REMOTE })
    client.setQueryData(queryKeys.agentConfig, { editable: false, files: [{ ...SETTINGS_FILE, writable: false }], userMcp: null })
    serveLive({ capabilities: REMOTE_ADMIN, listing: { editable: true, files: [SETTINGS_FILE], userMcp: null }, putStatus: 200 })
    renderSection(client)
    await waitFor(() => expect(document.querySelector('[data-slot="remote-settings-notice"]')).toBeTruthy())
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config-readonly"]')).toBeNull())
  })

  it('a save refused after the host withdrew the grant shows the refusal and goes read-only, not a conflict', async () => {
    const server: LiveServer = { capabilities: REMOTE_ADMIN, listing: { editable: true, files: [SETTINGS_FILE], userMcp: null }, putStatus: 200 }
    serveLive(server)
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="remote-settings-notice"]')).toBeTruthy())
    fireEvent.click(nav().getByText('.claude/settings.json'))
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    // The host runs `cez remote-settings disable` while the editor is open.
    Object.assign(server, { capabilities: READ_ONLY_REMOTE, listing: { editable: false, files: [{ ...SETTINGS_FILE, writable: false }], userMcp: null }, putStatus: 409 })
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(screen.getByText(/disabled on this remote cockpit/)).toBeTruthy())
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config-readonly"]')).toBeTruthy())
    expect(document.querySelector('[data-slot="agent-config-conflict"]')).toBeNull()
  })

  it('opening a file re-reads a grant the host made after the section loaded', async () => {
    const readOnly = { editable: false, files: [{ ...SETTINGS_FILE, writable: false }], userMcp: null }
    const server: LiveServer = { capabilities: READ_ONLY_REMOTE, listing: readOnly, putStatus: 200 }
    serveLive(server)
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config-readonly"]')).toBeTruthy())
    // The host runs `cez remote-settings enable` before the user picks a file.
    Object.assign(server, { capabilities: REMOTE_ADMIN, listing: { editable: true, files: [SETTINGS_FILE], userMcp: null } })
    fireEvent.click(nav().getByText('.claude/settings.json'))
    expect(await screen.findByRole('button', { name: 'Save file' })).toBeTruthy()
  })

  it('a version conflict keeps the rejected draft in the editor', async () => {
    const server: LiveServer = { capabilities: REMOTE_ADMIN, listing: { editable: true, files: [SETTINGS_FILE], userMcp: null }, putStatus: 409 }
    serveLive(server)
    renderSection()
    fireEvent.click(await findInNav('.claude/settings.json'))
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    await waitFor(() => expect(editor.value).toBe('{"a":1}'))
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config-conflict"]')).toBeTruthy())
    expect((screen.getByLabelText('.claude/settings.json contents') as HTMLTextAreaElement).value).toBe('{"a":2}')
  })

  it('a local cockpit shows no remote administration warning', async () => {
    serve({ editable: true, files: [], userMcp: null })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config"]')).toBeTruthy())
    expect(document.querySelector('[data-slot="remote-settings-notice"]')).toBeNull()
  })

  it('saves an edited file', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    await waitFor(() => expect(nav().getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(nav().getByText('.claude/settings.json'))
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeTruthy())
  })

  it('reports dirty state to the reload guard across edit, Save, and typing the old content back', async () => {
    const stop = trackTyping()
    try {
      serve({
        editable: true,
        files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
        userMcp: null,
      })
      renderSection()
      fireEvent.click(await findInNav('.claude/settings.json'))
      const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
      await waitFor(() => expect(editor.value).toBe('{"a":1}'))
      expect(hasUnsentInput()).toBe(false)

      editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      fireEvent.change(editor, { target: { value: '{"a":2}' } })
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      expect(hasUnsentInput()).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
      await waitFor(() => {
        expect(screen.queryByText('Unsaved changes')).toBeNull()
        expect(editor.value).toBe('{"a":2}')
      })
      expect(hasUnsentInput()).toBe(false)

      // Typing the original text back after Save is an unsaved edit.
      fireEvent.change(editor, { target: { value: '{"a":1}' } })
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      expect(hasUnsentInput()).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
      expect(hasUnsentInput()).toBe(false)
    } finally {
      stop()
    }
  })
})

describe('a config file that does not exist yet', () => {
  it('shows a faint example in its own format and says how to create the file', async () => {
    serve(
      { editable: true, files: [fileOf({ id: 'claude.settings', label: '.claude/settings.local.json', exists: false })], userMcp: null },
      '',
    )
    renderSection()
    const editor = (await screen.findByLabelText('.claude/settings.local.json contents')) as HTMLTextAreaElement
    const placeholder = await waitFor(() => {
      const found = document.querySelector('[data-slot="agent-config-placeholder"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(placeholder.textContent).toBe('// File not created yet — example:\n{\n  "permissions": {}\n}')
    expect(placeholder.getAttribute('aria-hidden')).toBe('true')
    expect((screen.getByRole('button', { name: 'Create file' }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-slot="agent-config-save-cue"]')?.textContent).toBe('Enter content above to create this file')

    // The first keystroke removes the example and the cue turns into the unsaved-changes note.
    fireEvent.change(editor, { target: { value: '{}' } })
    expect(document.querySelector('[data-slot="agent-config-placeholder"]')).toBeNull()
    expect(document.querySelector('[data-slot="agent-config-save-cue"]')?.textContent).toBe('Unsaved changes')
    expect((screen.getByRole('button', { name: 'Create file' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says the instructions file is not created yet', async () => {
    serve(
      { editable: true, files: [fileOf({ id: 'claude.memory', label: 'CLAUDE.local.md', kind: 'memory', format: 'markdown', exists: false })], userMcp: null },
      '',
    )
    renderSection()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="agent-config-placeholder"]')?.textContent).toBe('<!-- File not created yet — write instructions here -->'),
    )
  })

  it('says nothing changed, with no example, on a file that exists', async () => {
    serve({ editable: true, files: [SETTINGS_FILE], userMcp: null })
    renderSection()
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    await waitFor(() => expect(editor.value).toBe('{"a":1}'))
    expect(document.querySelector('[data-slot="agent-config-placeholder"]')).toBeNull()
    expect(document.querySelector('[data-slot="agent-config-save-cue"]')?.textContent).toBe('No unsaved changes')
  })
})
