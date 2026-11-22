import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type {
  AgentProfilesResponse,
  WorkspaceConfigResponse,
} from '@open-mercato/cezar-api-client'
import { RUNNER_IDS, seedRunners } from '@/test/runners.testkit'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Agents, "Defaults for new projects" (spec 2026-07-29-agent-profiles):
 * the agent and models a project uses when it has chosen none. An account is a project's own
 * choice, so this block offers none.
 *
 * What this pins is the STORE: the runner and the models go to the workspace config and never
 * reach the per-repo `/api/v1/config`, which is committable.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const ACCOUNTS: AgentProfilesResponse = {
  editable: true,
  profileCapableProviders: ['claude', 'codex'],
  selections: {},
  profiles: [
    {
      id: 'default',
      provider: 'claude',
      label: 'Default',
      configDir: '/home/u/.claude',
      path: '/home/u/.claude',
      exists: true,
      looksValid: true,
      isDefault: true,
    },
    {
      id: 'klaudiusz',
      provider: 'claude',
      label: 'Klaudiusz',
      configDir: '~/.claude-klaudiusz',
      path: '/home/u/.claude-klaudiusz',
      exists: true,
      looksValid: true,
      isDefault: false,
    },
  ],
}

const PROVIDERS = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'connected', enabled: true },
    { provider: 'pi', status: 'connected', enabled: true },
    { provider: 'omp', status: 'connected', enabled: true },
  ],
}

function serve({ agentDefaults = {} }: { agentDefaults?: WorkspaceConfigResponse['agentDefaults'] } = {}) {
  requests = []
  const state: WorkspaceConfigResponse = {
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    archiveOnMerge: null,
    effectiveArchiveOnMerge: false,
    archiveOnMergeSource: 'default',
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: true,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
    },
    agentDefaults,
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(state)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        const patch = (body?.agentDefaults ?? {}) as { runner?: string | undefined; models?: Record<string, string | null> }
        if (patch.runner !== undefined) state.agentDefaults.runner = patch.runner as never
        if (patch.models) {
          state.agentDefaults.models = { ...state.agentDefaults.models, ...patch.models } as never
        }
        return json(state)
      }
      if (url === '/api/v1/workspace/agent-profiles' && method === 'GET') return json(ACCOUNTS)
      if (url === '/api/v1/providers/status' && method === 'GET') return json(PROVIDERS)
      // The accounts page also paints per-agent facts from health; an empty answer is a real state
      // (it renders "Checking…") and keeps this file about the defaults block.
      if (url === '/api/v1/health' && method === 'GET') return json({ checks: [], bootProject: 'boot' })
      if (url.startsWith('/api/v1/open-targets')) return json({ targets: [] })
      if (url === '/api/v1/models?runner=claude') return json({ runner: 'claude', models: [], source: 'unavailable', stale: false })
      if (url === '/api/v1/models?runner=codex') return json({ models: [] })
      return new Promise<never>(() => {})
    }),
  )
}

function renderAccounts() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  seedRunners(client)
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/agents']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => [...document.querySelectorAll('[data-slot="agents-runner"] [role="radio"]')]
const rowFor = (runner: string) =>
  document.querySelector<HTMLButtonElement>(`[data-slot="agents-runner"] [data-value="${runner}"]`)
const configPuts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')
const selections = () =>
  requests.filter((r) => r.url === '/api/v1/workspace/agent-profiles/selection')
const repoConfigWrites = () => requests.filter((r) => r.url === '/api/v1/config')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Agents → Defaults for new projects', () => {
  it('survives a server that has never heard of agent defaults', async () => {
    // Version skew, and it crashed this page for real: Vite serves this bundle while `dist/` or
    // another process serves the API, so an older server answers `/workspace/config` with no
    // `agentDefaults` at all and the block read `.runner` off undefined. Fixed at the client
    // boundary — one place a missing key becomes the empty answer it means — so this guards the
    // whole class rather than the one line that happened to blow up.
    serve()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        requests.push({ method: init?.method ?? 'GET', url })
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
        if (url === '/api/v1/workspace/config') {
          return json({
            browseRoot: '~/',
            projectsDir: '~/cezar/projects',
            composerDefaults: {
              autonomous: null,
              worktree: null,
              inheritedAutonomous: 'source-dependent',
              inheritedWorktree: true,
            },
            resources: {
              maxParallel: 2,
              maxMonitoringSessions: 2,
              monitoringWakeIntervalMinutes: null,
              autoResumeOnUsageLimit: true,
              memoryLimitMb: null,
              worktreeRetentionDefault: 10,
            },
            // …and no `agentDefaults`.
          })
        }
        if (url === '/api/v1/workspace/agent-profiles') return json(ACCOUNTS)
        if (url === '/api/v1/providers/status') return json(PROVIDERS)
        if (url === '/api/v1/health') return json({ checks: [], bootProject: 'boot' })
        if (url.startsWith('/api/v1/open-targets')) return json({ targets: [] })
        return new Promise<never>(() => {})
      }),
    )
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(RUNNER_IDS.length))
    // The built-in fallback, rendered rather than thrown.
    expect(rowFor('claude')?.getAttribute('aria-checked')).toBe('true')
  })

  it('offers one row per agent, even for an agent with two accounts', async () => {
    serve()
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(RUNNER_IDS.length))
    expect(rows().map((r) => r.getAttribute('data-value'))).toEqual(RUNNER_IDS)
    // No machine opinion: claude is checked, which is what an unconfigured repo runs.
    expect(rowFor('claude')?.getAttribute('aria-checked')).toBe('true')
  })

  it('writes the runner to the WORKSPACE config, never the committable repo one', async () => {
    serve()
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(RUNNER_IDS.length))
    fireEvent.click(rowFor('codex')!)

    await waitFor(() => expect(configPuts()).toHaveLength(1))
    expect(configPuts()[0]?.body).toEqual({ agentDefaults: { runner: 'codex' } })
    expect(selections()).toHaveLength(0)
    expect(repoConfigWrites()).toHaveLength(0)
  })

  it('saves a default model to the workspace config, and clears it with null', async () => {
    serve({ agentDefaults: { models: { claude: 'opus' } } })
    renderAccounts()

    const select = () =>
      document.querySelector<HTMLSelectElement>('[data-slot="accounts-default-model"][data-runner="claude"]')
    await waitFor(() => expect(select()).not.toBeNull())
    expect(select()!.value).toBe('opus')

    fireEvent.change(select()!, { target: { value: '' } })
    await waitFor(() => expect(configPuts()).toHaveLength(1))
    // `null`, not an absent key: a partial patch cannot say "forget this" by omission, and a stale
    // value would keep seeding every unconfigured repo.
    expect(configPuts()[0]?.body).toEqual({ agentDefaults: { models: { claude: null } } })
    expect(repoConfigWrites()).toHaveLength(0)
  })

  it('switches the model editor without changing the default runner or another agent model', async () => {
    serve({ agentDefaults: { runner: 'claude', models: { claude: 'opus', codex: 'gpt-5.2-codex' } } })
    renderAccounts()
    const chooser = await screen.findByLabelText('Model agent')
    fireEvent.change(chooser, { target: { value: 'codex' } })
    const model = document.querySelector<HTMLSelectElement>('[data-slot="accounts-default-model"][data-runner="codex"]')!
    expect(model.value).toBe('gpt-5.2-codex')
    expect(configPuts()).toHaveLength(0)
    fireEvent.change(model, { target: { value: '' } })
    await waitFor(() => expect(configPuts()).toHaveLength(1))
    expect(configPuts()[0]?.body).toEqual({ agentDefaults: { models: { codex: null } } })
    expect(repoConfigWrites()).toHaveLength(0)
  })
})
