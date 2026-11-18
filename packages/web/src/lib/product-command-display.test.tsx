import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProductIdentity, type DisplayIdentity } from '../../product-identity'
import { conversationDeliveryExplanation } from '@/routes/task-thread/conversation-presentation'
import { createQueryClient } from '@/api/query-client'
import { CopyAsCliCard } from '@/routes/automations/copy-as-cli-card'
import { fromDefinition } from '@/routes/automations/editor-draft'
import { cliOf } from './automation-cli'

const state = vi.hoisted(() => ({ identity: undefined as DisplayIdentity | undefined }))
vi.mock('./product-name', async importOriginal => {
  const actual = await importOriginal<typeof import('./product-name')>()
  return {
    ...actual,
    productCommand: () => actual.productCommand(state.identity),
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const draft = fromDefinition({
  name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 },
  task: { prompt: 'Check', worktree: true },
})

describe('browser command hints', () => {
  it('uses the shared command for both generated automation forms', () => {
    state.identity = readProductIdentity()
    expect(cliOf(draft)).toBe(`${state.identity.command} automation add --name 'Nightly' --cron '0 4 * * *' --prompt 'Check'`)
    const json = cliOf({ ...draft, description: 'Details' })
    expect(json.startsWith(`${state.identity.command} automation create --json '`)).toBe(true)
    expect(json).toContain('"description":"Details"')
  })

  it('names the command that resumes an owned worker', () => {
    state.identity = readProductIdentity()
    expect(conversationDeliveryExplanation({ delivery: 'not-delivered', state: 'continuation-required' }, undefined))
      .toContain(`with ${state.identity.command} worker resume`)
  })

  it('renders the automation and remote settings hints from the shared identity', () => {
    state.identity = readProductIdentity()
    // Queries stay pending; seeded sources expose the remote hint without a network dependency.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const client = createQueryClient()
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/sample/settings']}>
          <CopyAsCliCard draft={draft} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText(`${state.identity.command} automation schema`)).toBeTruthy()
    expect(screen.getAllByText((text) => text.includes(`${state.identity!.command} automation add`)).length).toBeGreaterThan(0)
  })
})
