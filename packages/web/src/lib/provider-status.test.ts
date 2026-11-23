// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { ProviderStatusResponse } from '@open-mercato/cezar-api-client'
import {
  applyProviderStatusRow,
  mergeProviderStatusResponse,
  parseProviderStatusEventRow,
  parseProviderStatusResponse,
  providerStatusFor,
  runnableAccount,
  runnableAccounts,
  runnersOnAccount,
  signedOutRunners,
  uninstalledRunners,
  usableRunners,
} from './provider-status'
import { RUNNERS_RESPONSE } from '@/test/runners.testkit'

const CONNECTED: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'connected', enabled: true },
  ],
}

describe('provider-status runner order', () => {
  it('lists OMP last and accepts its SSE rows', () => {
    const rows = ['omp', 'claude', 'pi'].map((provider) => ({ provider, status: 'connected' as const, enabled: true }))
    expect(usableRunners({ providers: rows as ProviderStatusResponse['providers'] }, RUNNERS_RESPONSE)).toEqual(['claude', 'pi', 'omp'])
    expect(parseProviderStatusEventRow({ provider: 'omp', status: 'disconnected' })).toEqual({
      provider: 'omp',
      status: 'disconnected',
    })
  })
})

describe('provider-status SSE rows', () => {
  it('parses one coarse provider-status SSE row', () => {
    expect(parseProviderStatusEventRow({
      provider: 'claude',
      status: 'disconnected',
      hint: 'Reconnect, then try again.',
      authFailureId: 'incident-1',
      raw: 'private',
    })).toEqual({
      provider: 'claude',
      status: 'disconnected',
      hint: 'Reconnect, then try again.',
      authFailureId: 'incident-1',
    })
  })

  it.each([
    null,
    { provider: '', status: 'disconnected' },
    { provider: 'claude', status: 'future' },
    { provider: 'claude', status: 'disconnected', hint: 1 },
    { provider: 'claude', status: 'disconnected', authFailureId: 1 },
    { provider: 'claude', status: 'disconnected', authFailureId: '' },
    { provider: 'claude', status: 'disconnected', authFailureId: 'a'.repeat(129) },
    { provider: 'claude', status: 'connected', authFailureId: 'incident-1' },
  ])('rejects malformed provider-status SSE rows: %#', (value) => {
    expect(parseProviderStatusEventRow(value)).toBeNull()
  })

  it('merges one row immutably without inventing a missing cache', () => {
    expect(applyProviderStatusRow(undefined, {
      provider: 'claude',
      status: 'disconnected',
    })).toBeUndefined()

    expect(applyProviderStatusRow(CONNECTED, {
      provider: 'claude',
      status: 'disconnected',
    })).toEqual({
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        CONNECTED.providers[1],
        CONNECTED.providers[2],
      ],
    })
  })

  it('preserves cached enablement for an additive runtime event and accepts preference enablement', () => {
    const runtime = applyProviderStatusRow(CONNECTED, {
      provider: 'claude',
      status: 'disconnected',
      authFailureId: 'incident-1',
    })
    expect(runtime?.providers[0]).toEqual({
      provider: 'claude',
      status: 'disconnected',
      enabled: true,
      authFailureId: 'incident-1',
    })

    const preference = applyProviderStatusRow(runtime, {
      provider: 'claude',
      status: 'disconnected',
      enabled: false,
      authFailureId: 'incident-1',
    })
    expect(preference?.providers[0]?.enabled).toBe(false)
  })

  it('clears status-owned runtime fields when a recovery row omits them', () => {
    const incident = applyProviderStatusRow(CONNECTED, {
      provider: 'claude',
      status: 'disconnected',
      hint: 'Reconnect, then try again.',
      authFailureId: 'incident-1',
    })

    expect(applyProviderStatusRow(incident, {
      provider: 'claude',
      status: 'connected',
    })?.providers[0]).toEqual({
      provider: 'claude',
      status: 'connected',
      enabled: true,
    })
  })
})

describe('complete provider-status responses', () => {
  const STALE_CONNECTED: ProviderStatusResponse = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: false },
      { provider: 'codex', status: 'connected', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  }

  const INCIDENT: ProviderStatusResponse = {
    providers: [
      {
        provider: 'claude',
        status: 'disconnected',
        enabled: true,
        hint: 'Reconnect, then try again.',
        authFailureId: 'incident-2',
      },
      { provider: 'codex', status: 'connected', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  }

  it('keeps an incident that SSE added after the HTTP request started', () => {
    expect(mergeProviderStatusResponse(STALE_CONNECTED, INCIDENT, STALE_CONNECTED)).toEqual(INCIDENT)
  })

  it('lets retry clear only the exact incident it submitted', () => {
    expect(mergeProviderStatusResponse(INCIDENT, INCIDENT, STALE_CONNECTED, 'incident-1').providers[0]).toMatchObject({
      authFailureId: 'incident-2',
      status: 'disconnected',
    })
    expect(mergeProviderStatusResponse(INCIDENT, INCIDENT, STALE_CONNECTED, 'incident-2')).toEqual(STALE_CONNECTED)
  })

  it('does not resurrect an incident after an SSE recovery changed the cache', () => {
    const recovered = {
      ...INCIDENT,
      providers: [
        { provider: 'claude' as const, status: 'connected' as const, enabled: true },
        INCIDENT.providers[1]!,
        INCIDENT.providers[2]!,
      ],
    }
    const staleIncident = {
      ...INCIDENT,
      providers: [
        { ...INCIDENT.providers[0]! },
        INCIDENT.providers[1]!,
        INCIDENT.providers[2]!,
      ],
    }

    expect(mergeProviderStatusResponse(INCIDENT, recovered, staleIncident)).toEqual(recovered)
  })

  it('accepts an authoritative recovery when the cached incident has not changed', () => {
    expect(mergeProviderStatusResponse(INCIDENT, INCIDENT, STALE_CONNECTED)).toEqual(STALE_CONNECTED)
  })

  it('accepts a newer incident from an authoritative response when no SSE changed the cache', () => {
    const incidentB = {
      ...INCIDENT,
      providers: [
        { ...INCIDENT.providers[0]!, authFailureId: 'incident-b' },
        INCIDENT.providers[1]!,
        INCIDENT.providers[2]!,
      ],
    }

    expect(mergeProviderStatusResponse(INCIDENT, INCIDENT, incidentB)).toEqual(incidentB)
  })

  it('keeps an SSE incident that changed during an in-flight connected response', () => {
    const incidentB = {
      ...INCIDENT,
      providers: [
        { ...INCIDENT.providers[0]!, authFailureId: 'incident-b' },
        INCIDENT.providers[1]!,
        INCIDENT.providers[2]!,
      ],
    }

    expect(mergeProviderStatusResponse(INCIDENT, incidentB, STALE_CONNECTED)).toEqual(incidentB)
  })
})

describe('parseProviderStatusResponse', () => {
  it('keeps the row order the server sent and public fields only', () => {
    expect(
      parseProviderStatusResponse({
        ignored: 'private top-level value',
        providers: [
          { provider: 'opencode', status: 'unknown', enabled: true, hint: 'Try again.', raw: 'private' },
          { provider: 'claude', status: 'connected', enabled: true, account: 'private@example.test' },
          { provider: 'codex', status: 'disconnected', enabled: false },
        ],
      }),
    ).toEqual({
      providers: [
        { provider: 'opencode', status: 'unknown', enabled: true, hint: 'Try again.' },
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'disconnected', enabled: false },
      ],
    })
  })

  it.each([
    ['an empty object', {}],
    ['a null providers value', { providers: null }],
    ['a null row', { providers: [null] }],
    [
      'an unknown provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected' },
          { provider: 'future', status: 'connected' },
        ],
      },
    ],
    [
      'an unknown state',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'ready' },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
    [
      'a duplicate provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'claude', status: 'disconnected' },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
    [
      'a missing provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected' },
        ],
      },
    ],
    [
      'a non-string hint',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected', hint: { raw: 'private' } },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
  ])('rejects %s', (_case, value) => {
    expect(() => parseProviderStatusResponse(value)).toThrow('Invalid provider status response')
  })

  it('requires enabled on every complete response row', () => {
    expect(() => parseProviderStatusResponse({
      providers: [
        { provider: 'claude', status: 'connected' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    })).toThrow('Invalid provider status response')
  })
})

describe('usableRunners', () => {
  it('returns only enabled connected providers in the order of the runners list', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'opencode', status: 'connected', enabled: false },
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: false },
      ],
    }

    expect(usableRunners(status, RUNNERS_RESPONSE)).toEqual(['claude'])
  })

  it('returns [] until the runners list answers', () => {
    expect(usableRunners(CONNECTED, undefined)).toEqual([])
  })

  it('drops a provider the runners list does not name', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'future', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
      ],
    }
    expect(parseProviderStatusEventRow({ provider: 'future', status: 'disconnected' })).toEqual({
      provider: 'future',
      status: 'disconnected',
    })
    expect(usableRunners(status, RUNNERS_RESPONSE)).toEqual(['codex'])
  })

  it('returns [] for undefined/pending status', () => {
    expect(usableRunners(undefined, RUNNERS_RESPONSE)).toEqual([])
  })

  it('degrades a malformed successful response to no verified providers', () => {
    expect(usableRunners({} as ProviderStatusResponse, RUNNERS_RESPONSE)).toEqual([])
    expect(usableRunners({ providers: [null] } as unknown as ProviderStatusResponse, RUNNERS_RESPONSE)).toEqual([])
    expect(usableRunners({
      providers: [{ provider: 'claude', status: 'connected' }],
    } as unknown as ProviderStatusResponse, RUNNERS_RESPONSE)).toEqual([])
  })

  it('does not fall back to claude when none is connected', () => {
    expect(usableRunners({ providers: [] }, RUNNERS_RESPONSE)).toEqual([])
  })

  it('excludes disconnected, not-installed, and unknown rows', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        { provider: 'codex', status: 'not-installed', enabled: true },
        { provider: 'opencode', status: 'unknown', enabled: true },
      ],
    }

    expect(usableRunners(status, RUNNERS_RESPONSE)).toEqual([])
  })
})

describe('providerStatusFor', () => {
  it('returns the matching provider row', () => {
    const codex = { provider: 'codex', status: 'disconnected', enabled: true, hint: 'Run codex login.' } as const
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        codex,
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }

    expect(providerStatusFor(status, 'codex')).toEqual(codex)
  })

  it('returns undefined while data is unavailable', () => {
    expect(providerStatusFor(undefined, 'claude')).toBeUndefined()
    expect(
      providerStatusFor({ providers: [null] } as unknown as ProviderStatusResponse, 'claude'),
    ).toBeUndefined()
    expect(providerStatusFor({
      providers: [{ provider: 'claude', status: 'connected' }],
    } as unknown as ProviderStatusResponse, 'claude')).toBeUndefined()
  })
})

describe('runner availability with agent accounts (hearsay-tools/squawk#4116)', () => {
  // Antigravity-shaped: the default account is signed out, a second account is signed in.
  const DEFAULT_SIGNED_OUT: ProviderStatusResponse = {
    providers: [
      { provider: 'claude', status: 'disconnected', enabled: true },
      { provider: 'codex', status: 'connected', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  }
  const defaultClaude = { provider: 'claude', id: 'default', isDefault: true } as const
  const work = { provider: 'claude', id: 'work', isDefault: false, status: 'connected' } as const
  const old = { provider: 'claude', id: 'old', isDefault: false, status: 'disconnected' } as const
  const unprobed = { provider: 'claude', id: 'new', isDefault: false } as const

  it('keeps a runner usable when its default account is signed out and another account is connected', () => {
    expect(usableRunners(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE, [defaultClaude, work])).toEqual(['claude', 'codex'])
    expect(signedOutRunners(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE, [defaultClaude, work])).toEqual([])
  })

  it('lists an installed runner with no connected account as signed out, never dropping it', () => {
    const accounts = [defaultClaude, old, unprobed]
    expect(usableRunners(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE, accounts)).toEqual(['codex'])
    expect(signedOutRunners(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE, accounts)).toEqual(['claude'])
    // Not-installed stays its own list; a signed-out runner is never counted twice.
    expect(uninstalledRunners(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE)).toEqual(['opencode'])
  })

  it('never counts a disabled runner as usable or signed out', () => {
    const disabled: ProviderStatusResponse = {
      providers: [{ provider: 'claude', status: 'disconnected', enabled: false }],
    }
    expect(usableRunners(disabled, RUNNERS_RESPONSE, [work])).toEqual([])
    expect(signedOutRunners(disabled, RUNNERS_RESPONSE, [work])).toEqual([])
  })

  it('offers only accounts not known to be signed out', () => {
    expect(runnableAccounts(DEFAULT_SIGNED_OUT, [defaultClaude, work, old, unprobed])).toEqual([work, unprobed])
  })

  it('replaces a signed-out default account with a connected one', () => {
    const accounts = [defaultClaude, work]
    // Untouched picker, project follows the default account: name the connected account explicitly.
    expect(runnableAccount(DEFAULT_SIGNED_OUT, accounts, 'claude', null, undefined)).toBe('work')
    // An explicit pick of the signed-out default account is replaced too.
    expect(runnableAccount(DEFAULT_SIGNED_OUT, accounts, 'claude', 'default', undefined)).toBe('work')
    // The project's selection is connected: follow it and send no key.
    expect(runnableAccount(DEFAULT_SIGNED_OUT, accounts, 'claude', null, { claude: 'work' })).toBeNull()
  })

  it('keeps the pick and the project selection when they are signed in', () => {
    const connected: ProviderStatusResponse = {
      providers: [{ provider: 'claude', status: 'connected', enabled: true }],
    }
    expect(runnableAccount(connected, [defaultClaude, work], 'claude', 'work', undefined)).toBe('work')
    expect(runnableAccount(connected, [defaultClaude, work], 'claude', null, undefined)).toBeNull()
    // A signed-out project selection falls back to the connected default account.
    expect(runnableAccount(connected, [defaultClaude, old], 'claude', null, { claude: 'old' })).toBe('default')
    // A pick that belongs to another runner is dropped.
    expect(runnableAccount(connected, [defaultClaude, work], 'codex', 'work', undefined)).toBeNull()
  })

  it('binds a surface that sends no account to the account it runs on', () => {
    const accounts = [defaultClaude, work, old]
    // The project's selection is the signed-out default: claude is a sign-in link, not a choice.
    expect(runnersOnAccount(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE, accounts, () => undefined))
      .toEqual({ runners: ['codex'], signedOut: ['claude'] })
    // The run continues on the connected named account: claude is a choice.
    expect(runnersOnAccount(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE, accounts, (runner) => runner === 'claude' ? 'work' : undefined))
      .toEqual({ runners: ['claude', 'codex'], signedOut: [] })
    expect(runnersOnAccount(DEFAULT_SIGNED_OUT, RUNNERS_RESPONSE, accounts, (runner) => runner === 'claude' ? 'old' : undefined).runners)
      .toEqual(['codex'])
  })

  it('sends no account when no account of the runner is connected', () => {
    expect(runnableAccount(DEFAULT_SIGNED_OUT, [defaultClaude, old], 'claude', null, undefined)).toBeNull()
  })
})
