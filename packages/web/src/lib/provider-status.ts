import type { ProviderStatus, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-api-client/contract/agent-profiles'

const PROVIDER_STATES = new Set(['connected', 'disconnected', 'not-installed', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type ProviderStatusEventRow = Omit<ProviderStatus, 'enabled'> & { enabled?: boolean }

/** Complete HTTP rows must carry `enabled`; SSE event rows may omit it. */
function enabledAcceptable(enabled: unknown, requireEnabled: boolean): boolean {
  if (typeof enabled === 'boolean') return true
  return !requireEnabled && enabled === undefined
}

/** An incident id may appear only on a `disconnected` row and must be a short string. */
function authFailureIdAcceptable(authFailureId: unknown, status: string): boolean {
  if (authFailureId === undefined) return true
  return (
    typeof authFailureId === 'string'
    && authFailureId.length >= 1
    && authFailureId.length <= 128
    && status === 'disconnected'
  )
}

function rowFieldsAcceptable(
  provider: unknown,
  status: unknown,
  enabled: unknown,
  hint: unknown,
  authFailureId: unknown,
  requireEnabled: boolean,
): boolean {
  return (
    typeof provider === 'string'
    && provider.length > 0
    && typeof status === 'string'
    && PROVIDER_STATES.has(status)
    && enabledAcceptable(enabled, requireEnabled)
    && (hint === undefined || typeof hint === 'string')
    && authFailureIdAcceptable(authFailureId, status as string)
  )
}

function parseProviderStatusRow(
  value: unknown,
  requireEnabled: boolean,
): ProviderStatusEventRow | null {
  if (!isRecord(value)) return null
  const { provider, status, enabled, hint, authFailureId } = value
  if (
    !rowFieldsAcceptable(provider, status, enabled, hint, authFailureId, requireEnabled)
  ) return null
  return {
    provider: provider as Runner,
    status: status as ProviderStatus['status'],
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(typeof hint === 'string' ? { hint } : {}),
    ...(typeof authFailureId === 'string' ? { authFailureId } : {}),
  }
}

export function parseProviderStatusEventRow(value: unknown): ProviderStatusEventRow | null {
  return parseProviderStatusRow(value, false)
}

function safeProviderRows(value: unknown, requireEnabled: boolean): ProviderStatusEventRow[] | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) return null
  const rows: ProviderStatusEventRow[] = []
  const seen = new Set<string>()
  for (const valueRow of value.providers) {
    const row = parseProviderStatusRow(valueRow, requireEnabled)
    if (row === null || seen.has(row.provider)) return null
    seen.add(row.provider)
    rows.push(row)
  }
  return rows
}

function completeProviderRows(value: unknown): ProviderStatus[] | null {
  const rows = safeProviderRows(value, true)
  if (rows === null || rows.length === 0) return null
  return rows as ProviderStatus[]
}

export function parseProviderStatusResponse(value: unknown): ProviderStatusResponse {
  const rows = completeProviderRows(value)
  if (rows === null) {
    throw new Error('Invalid provider status response')
  }
  return { providers: rows }
}

export function applyProviderStatusRow(
  response: ProviderStatusResponse | undefined,
  row: ProviderStatusEventRow,
): ProviderStatusResponse | undefined {
  const providers = completeProviderRows(response)
  if (providers === null) return undefined
  return {
    providers: providers.map((candidate) => {
      if (candidate.provider !== row.provider) return candidate
      // An event row owns discovery/runtime status. Only enablement is additive because runtime
      // rows intentionally omit the workspace preference; carrying old hints or incident ids
      // through a connected recovery would otherwise leave another tab falsely red.
      return {
        provider: row.provider,
        status: row.status,
        enabled: row.enabled ?? candidate.enabled,
        ...(row.hint === undefined ? {} : { hint: row.hint }),
        ...(row.authFailureId === undefined ? {} : { authFailureId: row.authFailureId }),
      }
    }),
  }
}

/**
 * Fold a complete HTTP answer into the workspace cache. A row is authoritative only when its
 * cached value still matches the snapshot captured at request start; an SSE update in between
 * wins. Retry is the sole clearing exception, and it may clear only the id it submitted.
 */
export function mergeProviderStatusResponse(
  requestStart: ProviderStatusResponse | undefined,
  cached: ProviderStatusResponse | undefined,
  response: ProviderStatusResponse,
  retryIncidentId?: string,
): ProviderStatusResponse {
  const requestStartRows = completeProviderRows(requestStart)
  const cachedRows = completeProviderRows(cached)
  const responseRows = completeProviderRows(response)
  if (responseRows === null || cachedRows === null) return response
  if (requestStartRows === null) return { providers: cachedRows }
  const requestStartByProvider = new Map(requestStartRows.map((row) => [row.provider, row]))
  const cachedByProvider = new Map(cachedRows.map((row) => [row.provider, row]))

  return {
    providers: responseRows.map((incoming) => {
      const before = requestStartByProvider.get(incoming.provider)
      const current = cachedByProvider.get(incoming.provider)
      if (before === undefined || current === undefined) return current ?? incoming
      const retryClearsCurrent = retryIncidentId !== undefined
        && current.authFailureId === retryIncidentId
        && incoming.authFailureId === undefined
      const clearsDifferentIncident = retryIncidentId !== undefined
        && current.authFailureId !== undefined
        && current.authFailureId !== retryIncidentId
        && incoming.authFailureId === undefined
      if (clearsDifferentIncident) return current
      if (sameProviderStatusRow(before, current)) return incoming
      if (retryClearsCurrent) {
        return { ...incoming, enabled: current.enabled }
      }
      return current
    }),
  }
}

function sameProviderStatusRow(left: ProviderStatus, right: ProviderStatus): boolean {
  return left.provider === right.provider
    && left.status === right.status
    && left.enabled === right.enabled
    && left.hint === right.hint
    && left.authFailureId === right.authFailureId
}

/**
 * One agent account's sign-in state, as the runner pickers read it (spec 2026-07-29-agent-profiles).
 *
 * The provider-status row speaks for the DEFAULT account only. A named account carries its own
 * `status`, absent while the server has not probed it yet.
 */
export interface AccountSignIn {
  provider: Runner
  id: string
  isDefault?: boolean | undefined
  status?: ProviderStatus['status'] | undefined
}

function namedAccountConnected(accounts: readonly AccountSignIn[], provider: Runner): boolean {
  return accounts.some((account) => account.provider === provider && !account.isDefault && account.status === 'connected')
}

/** Installed, and at least one account (the default or a named one) is connected. */
export function runnerSignedIn(row: ProviderStatus, accounts: readonly AccountSignIn[]): boolean {
  if (row.status === 'not-installed') return false
  return row.status === 'connected' || namedAccountConnected(accounts, row.provider)
}

/** Enabled, installed, and at least one account is connected. */
function rowUsable(row: ProviderStatus, accounts: readonly AccountSignIn[]): boolean {
  return row.enabled === true && runnerSignedIn(row, accounts)
}

function registeredWhere(
  status: ProviderStatusResponse | undefined,
  runners: RunnersResponse | undefined,
  keep: (row: ProviderStatus) => boolean,
): Runner[] {
  const rows = completeProviderRows(status)
  if (rows === null) return []
  const kept = new Set(rows.filter(keep).map((row) => row.provider))
  return (runners?.runners ?? []).map((entry) => entry.id).filter((runner) => kept.has(runner))
}

/** The registered runners a task can start on, in the runners list's display order: enabled,
 *  installed, and signed in on at least one account. Pass the agent accounts, or a runner whose
 *  default account is signed out vanishes even when another of its accounts is connected.
 *  Empty until both the provider status and the runners list have answered. */
export function usableRunners(
  status: ProviderStatusResponse | undefined,
  runners: RunnersResponse | undefined,
  accounts: readonly AccountSignIn[] = [],
): Runner[] {
  return registeredWhere(status, runners, (row) => rowUsable(row, accounts))
}

/** The registered runners that are enabled and installed but have no connected account. Runner
 *  pickers list them greyed out, as links to their global Settings card, so a signed-out runner
 *  never disappears from the picker. */
export function signedOutRunners(
  status: ProviderStatusResponse | undefined,
  runners: RunnersResponse | undefined,
  accounts: readonly AccountSignIn[] = [],
): Runner[] {
  return registeredWhere(
    status,
    runners,
    (row) => row.enabled === true && row.status !== 'not-installed' && !rowUsable(row, accounts),
  )
}

/** True when `account` is KNOWN to be signed out. The default account reads the provider row; a
 *  named account its own status, and one not probed yet is not counted as signed out. */
function accountSignedOut(status: ProviderStatusResponse | undefined, account: AccountSignIn): boolean {
  if (account.isDefault || account.id === DEFAULT_AGENT_ACCOUNT_ID) {
    const row = providerStatusFor(status, account.provider)
    return row !== undefined && row.status !== 'connected'
  }
  return account.status !== undefined && account.status !== 'connected'
}

function accountConnected(status: ProviderStatusResponse | undefined, account: AccountSignIn): boolean {
  if (account.isDefault || account.id === DEFAULT_AGENT_ACCOUNT_ID) {
    return providerStatusFor(status, account.provider)?.status === 'connected'
  }
  return account.status === 'connected'
}

/** The accounts a picker may offer: every account not known to be signed out. A signed-out
 *  account is never a row, so a task cannot be started on it from the picker. */
export function runnableAccounts<T extends AccountSignIn>(
  status: ProviderStatusResponse | undefined,
  accounts: readonly T[],
): T[] {
  return accounts.filter((account) => !accountSignedOut(status, account))
}

/**
 * The account a start on `runner` sends as `agentProfile`.
 *
 * - The user's pick, when it belongs to `runner` and is not signed out.
 * - `null` (follow the project's selection) when the account the selection resolves to is not
 *   signed out. An untouched picker keeps sending no key, as before.
 * - Otherwise the first connected account of `runner`, named explicitly, so the task never starts
 *   on a signed-out account the server would pick by default.
 */
export function runnableAccount(
  status: ProviderStatusResponse | undefined,
  accounts: readonly AccountSignIn[],
  runner: Runner,
  picked: string | null | undefined,
  repoAccount: Partial<Record<Runner, string>> | undefined,
): string | null {
  const own = accounts.filter((account) => account.provider === runner)
  const pickedAccount = own.find((account) => account.id === picked)
  if (pickedAccount && !accountSignedOut(status, pickedAccount)) return pickedAccount.id
  const selected = repoAccount?.[runner]
  const followed = own.find((account) => account.id === selected)
    ?? { provider: runner, id: DEFAULT_AGENT_ACCOUNT_ID, isDefault: true }
  if (!accountSignedOut(status, followed)) return null
  // Listing order: the default account first, then the named ones.
  const connected = own.find((account) => accountConnected(status, account))
  return connected?.id ?? null
}

export function providerStatusFor(
  status: ProviderStatusResponse | undefined,
  provider: Runner,
): ProviderStatus | undefined {
  return completeProviderRows(status)?.find((row) => row.provider === provider)
}

/** The registered runners the host reports as not installed, in the runners list's display
 *  order. Runner pickers list them greyed out, as links to their global Settings card, so a
 *  runner never disappears from the picker just because its CLI is missing. Empty until both
 *  the provider status and the runners list have answered. */
export function uninstalledRunners(
  status: ProviderStatusResponse | undefined,
  runners: RunnersResponse | undefined,
): Runner[] {
  return registeredWhere(status, runners, (row) => row.status === 'not-installed')
}
