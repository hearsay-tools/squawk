import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RunnerInstallStatus } from '@open-mercato/cezar-api-client/contract/runner-install'
import { getRunnerInstall, changeRunnerInstall } from '@/api/runner-install'
import { ManagedCli } from './managed-cli'

const permission = vi.hoisted(() => ({ allowed: true }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { settingsAdmin: permission.allowed } } }) }))
vi.mock('@/api/runner-install', () => ({ getRunnerInstall: vi.fn(), changeRunnerInstall: vi.fn() }))

const initial: RunnerInstallStatus = { supported: true, installedVersion: null, latestVersion: '1.5.14', updateAvailable: false, phase: 'idle', error: null }
const clients: QueryClient[] = []
beforeEach(() => { permission.allowed = true; vi.mocked(getRunnerInstall).mockResolvedValue(initial) })
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks() })

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><ManagedCli runner="antigravity" /></QueryClientProvider>)
  return client
}

it('installs, shows progress, then updates and removes the managed CLI', async () => {
  const client = view()
  await waitFor(() => expect((screen.getByRole('button', { name: 'Install CLI' }) as HTMLButtonElement).disabled).toBe(false))
  vi.mocked(changeRunnerInstall).mockResolvedValue({ ...initial, phase: 'downloading' })
  fireEvent.click(screen.getByRole('button', { name: 'Install CLI' }))
  await waitFor(() => expect(changeRunnerInstall).toHaveBeenCalledWith('antigravity', 'install'))
  await screen.findByText(/Downloading CLI/)
  expect((screen.getByRole('button', { name: 'Install CLI' }) as HTMLButtonElement).disabled).toBe(true)
  vi.mocked(getRunnerInstall).mockResolvedValue({ ...initial, installedVersion: '1.5.14' })
  await client.invalidateQueries({ queryKey: ['runner-install', 'antigravity'] })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Update CLI' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.getByRole('status').textContent).toContain('Installed CLI 1.5.14')
  vi.mocked(changeRunnerInstall).mockResolvedValue({ ...initial, installedVersion: '1.5.14' })
  fireEvent.click(screen.getByRole('button', { name: 'Update CLI' }))
  await waitFor(() => expect(changeRunnerInstall).toHaveBeenLastCalledWith('antigravity', 'update'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Remove CLI' }) as HTMLButtonElement).disabled).toBe(false))
  vi.mocked(changeRunnerInstall).mockResolvedValue(initial)
  fireEvent.click(screen.getByRole('button', { name: 'Remove CLI' }))
  await waitFor(() => expect(changeRunnerInstall).toHaveBeenLastCalledWith('antigravity', 'remove'))
  await screen.findByRole('button', { name: 'Install CLI' })
});

it('hides installation and makes no request without settingsAdmin', () => {
  permission.allowed = false; view()
  expect(screen.queryByRole('button')).toBeNull()
  expect(getRunnerInstall).not.toHaveBeenCalled()
});

it('shows a checksum failure and lets the user retry installation', async () => {
  vi.mocked(getRunnerInstall).mockResolvedValue({ ...initial, phase: 'failed', error: 'The CLI sha512 checksum does not match.' })
  view()
  expect((await screen.findByRole('alert')).textContent).toContain('sha512')
  expect((screen.getByRole('button', { name: 'Install CLI' }) as HTMLButtonElement).disabled).toBe(false)
});
