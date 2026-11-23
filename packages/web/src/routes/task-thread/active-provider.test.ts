import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit';
import { providerForActiveRun } from '@open-mercato/cezar-api-client/contract/active-provider';
// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { ApiRun, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

import {
  activeProviderAvailability,
  existingProviderAvailability,
  providerForExistingRun,
  runAccountChoice,
  runAccountId,
} from './active-provider'
import { RUNNERS_RESPONSE } from '@/test/runners.testkit'

const run = (overrides: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: RUN_STATUS.waiting,
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...overrides,
})

const providers = (overrides: Partial<ProviderStatusResponse> = {}): ProviderStatusResponse => ({
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'connected', enabled: true },
  ],
  ...overrides,
})

describe('active task provider availability', () => {
  it('uses the current step backend before a disabled run runner', () => {
    const active = run({
      runner: 'claude',
      currentStepId: 'retry',
      steps: [{ id: 'retry', name: 'Retry', kind: STEP_KIND.agent, status: STEP_STATUS.waiting, iterations: 1, tokensUsed: 0, backend: 'codex' }],
    })
    const status = providers({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })

    expect(providerForActiveRun(active)).toBe('codex')
    expect(activeProviderAvailability(active, status, RUNNERS_RESPONSE)).toEqual({ provider: 'codex', usable: true })
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }, 'Claude Code is disabled. Enable it in Settings → Agent defaults → Providers.'],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }, 'Claude Code credentials are unavailable. Authorize it in Settings → Agent defaults → Providers.'],
  ] as const)('reports the fixed server-safe reason for a %s active provider', (_case, row, reason) => {
    const status = providers({ providers: [row, ...providers().providers.slice(1)] })

    expect(activeProviderAvailability(run({ runner: 'claude' }), status, RUNNERS_RESPONSE)).toEqual({
      provider: 'claude',
      usable: false,
      reason,
    })
  })

  it('gates an override-free continuation on the run provider, not a connected fallback', () => {
    const closed = run({
      status: RUN_STATUS.done,
      runner: 'claude',
      steps: [{
        id: 'continue-1',
        name: 'Continue',
        kind: STEP_KIND.agent,
        status: STEP_STATUS.done,
        iterations: 1,
        tokensUsed: 0,
        backend: 'codex',
        sessionId: 'session-1',
      }],
    })
    const status = providers({
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })

    expect(providerForExistingRun(closed)).toBe('claude')
    expect(existingProviderAvailability(closed, status, RUNNERS_RESPONSE)).toEqual({
      provider: 'claude',
      usable: false,
      reason: 'Claude Code credentials are unavailable. Authorize it in Settings → Agent defaults → Providers.',
    })
  })
})

describe('the account a run continues on (hearsay-tools/squawk#4116)', () => {
  const mixed = run({
    runner: 'claude',
    agentProfile: 'work',
    steps: [{ id: 'b', name: 'B', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 0, tokensUsed: 0, backend: 'codex', sessionId: 's-codex', startedAt: '2026-11-23T00:01:00.000Z' }],
  })

  it('mirrors the engine: run account on its runner, session account on the session runner, else the selection', () => {
    expect(runAccountId(mixed, 'claude', { claude: 'old' })).toBe('work')
    expect(runAccountId(mixed, 'codex', undefined)).toBe('default')
    expect(runAccountId(mixed, 'opencode', { opencode: 'x' })).toBe('x')
  })

  it('lets a run on a connected named account continue while the default account is signed out', () => {
    const work = { provider: 'claude', id: 'work', label: 'Work', configDir: '~/.claude-work', isDefault: false, status: 'connected' } as const
    const status = providers({ providers: [{ provider: 'claude', status: 'disconnected', enabled: true }] })
    const account = runAccountChoice(run({ runner: 'claude', agentProfile: 'work' }), 'claude', [work], undefined)
    expect(existingProviderAvailability(run({ runner: 'claude', agentProfile: 'work' }), status, RUNNERS_RESPONSE, account))
      .toEqual({ provider: 'claude', usable: true })
    const signedOut = { ...work, status: 'disconnected' } as const
    expect(existingProviderAvailability(run({ runner: 'claude', agentProfile: 'work' }), status, RUNNERS_RESPONSE, signedOut).reason)
      .toBe('Claude Code account "Work" is not signed in. Sign in in Settings → Agent defaults → Providers.')
  })
})
