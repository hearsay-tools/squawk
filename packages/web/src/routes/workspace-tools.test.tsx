import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { WorkspaceToolsRoute } from './workspace-tools'
import { RUNNERS_RESPONSE } from '@/test/runners.testkit'

const mocks = vi.hoisted(() => ({ refetch: vi.fn(), copy: vi.fn(), allAvailable: false, hint: 'Install the Codex CLI', version: '0.9' }))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { version: '1.2.3', repoRoot: '/local/repo', checks: [{ name: 'git', available: true, version: '2.50' }, mocks.allAvailable ? { name: 'codex', available: true, version: mocks.version } : { name: 'codex', available: false, hint: mocks.hint }], capabilities: {} }, refetch: mocks.refetch, isFetching: false, isError: false }),
  useProjects: () => ({ data: { projectsDir: '/local/projects' } }),
}))
vi.mock('@/api/runners', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/runners')>()
  return { ...actual, useRunners: () => ({ data: RUNNERS_RESPONSE }) }
})
vi.mock('@/components/add-project-dialog', () => ({ AddProjectDialog: () => <div role="dialog" aria-label="Choose local folder" /> }))
vi.mock('@/components/clone-project-dialog', () => ({ CloneProjectDialog: () => <div role="dialog" aria-label="Clone repository" /> }))
vi.mock('@/components/create-project-dialog', () => ({ CreateProjectDialog: () => <div role="dialog" aria-label="New project" /> }))
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.allAvailable = false; mocks.hint = 'Install the Codex CLI'; mocks.version = '0.9'; vi.unstubAllGlobals() })

describe('Workspace tools', () => {
  it('opens all three project flows from the shared workspace page', () => {
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Open local folder' }))
    expect(screen.getByRole('dialog', { name: 'Choose local folder' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clone from GitHub' }))
    expect(screen.getByRole('dialog', { name: 'Clone repository' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy()
  })

  it('rechecks the real tool inventory and copies only the reported diagnostics', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.copy.mockResolvedValue(undefined) } })
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Recheck tools' }))
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1))
    expect(JSON.parse(mocks.copy.mock.calls[0]![0])).toEqual({ version: '1.2.3', checks: [{ name: 'git', available: true, version: '2.50' }, { name: 'codex', available: false, hint: 'Install the Codex CLI' }] })
    expect(screen.getByText('Not installed')).toBeTruthy()
  })

  it('explains tool status and offers setup inside valid diagnostic rows only for missing tools', () => {
    const { container } = render(<MemoryRouter initialEntries={['/tools']}><WorkspaceToolsRoute /></MemoryRouter>)
    const git = container.querySelector('[data-slot="tool-row"][data-tool="git"]')!
    const codex = container.querySelector('[data-slot="tool-row"][data-tool="codex"]')!
    expect(git.textContent).toContain('Installed')
    expect(git.textContent).toContain('git')
    expect(codex.textContent).toContain('Codex')
    expect(codex.textContent).toContain('Not installed')
    expect(screen.getByRole('heading', { name: 'Active project' })).toBeTruthy()
    expect(codex.querySelector('[data-slot="tool-hint"]')?.textContent).toBe('Install the Codex CLI')
    expect(git.querySelector('[data-slot="tool-hint"]')).toBeNull()
    for (const row of container.querySelectorAll('[data-slot="tool-row"]')) {
      expect([...row.children].every((el) => el.tagName === 'DT' || el.tagName === 'DD')).toBe(true)
    }
    expect(codex.querySelector('[data-slot="tool-setup"]')?.parentElement?.tagName).toBe('DD')
    const setups = screen.getAllByRole('link', { name: 'Set up ›' })
    expect(setups).toHaveLength(1)
    expect(codex.querySelector('[data-slot="tool-setup"]')).toBe(setups[0])
    expect(setups[0]!.getAttribute('href')).toBe('/settings/global/agents#agent-codex')
    expect(screen.getByRole('link', { name: 'Tool settings ›' }).getAttribute('href')).toBe('/settings/global/agents')
  })

  it('has no "Set up" link when every tool is available', () => {
    mocks.allAvailable = true
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: /Set up/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Tool settings ›' })).toBeTruthy()
  })

  it('shows a dry-run version as a calm pill with the raw string in its tooltip', () => {
    mocks.allAvailable = true
    mocks.version = 'mock (HSQ_DRY_RUN=1)'
    const { container } = render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    const codex = container.querySelector('[data-slot="tool-row"][data-tool="codex"]')!
    const pill = codex.querySelector('[data-slot="tool-dry-run"]')
    expect(pill?.textContent).toBe('Dry run')
    expect(pill?.getAttribute('title')).toBe('mock (HSQ_DRY_RUN=1)')
    expect(codex.textContent).not.toContain('HSQ_DRY_RUN')
    // A real version still reads inline.
    expect(container.querySelector('[data-slot="tool-row"][data-tool="git"]')?.textContent).toContain('Installed· 2.50')
  })

  it('renders backticked CLI commands as code chips and capitalizes leading Install', () => {
    mocks.hint = 'install gh and run `gh auth login`'
    const { container } = render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    const hint = container.querySelector('[data-slot="tool-hint"]')!
    expect(hint.textContent).toBe('Install gh and run gh auth login')
    expect(hint.querySelector('code')?.textContent).toBe('gh auth login')
  })
})
