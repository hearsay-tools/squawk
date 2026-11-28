import { useQueries } from '@tanstack/react-query'
import type { AgentProfilesResponse, ProviderStatus, Runner } from '@open-mercato/cezar-api-client'

import { getAgentAccountStatus } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { useAgentProfiles, useProviderStatus, useRepo, workspaceQueryKeys } from '@/api/queries'
import { useRunners } from '@/api/runners'
import type { RunnerAccountChoice } from '@/components/picker-pill'
import {
  runnableAccount,
  runnableAccounts,
  runnerReadyOn,
  runnersOnAccount,
  signedOutRunners,
  uninstalledRunners,
  usableRunners,
} from '@/lib/provider-status'

/**
 * The agent accounts a runner pill needs (spec 2026-07-29-agent-profiles), in ONE place.
 *
 * Every surface that offers "which agent, and which of its logins" asks the same two questions —
 * what logins exist, and which one this project falls back to — and answering them separately is
 * how the /new composer, the GitHub hand-off and the thread's Continue drift into three pills that
 * look alike and pick differently.
 */
export interface AgentAccountChoices {
  /** Every login for every runner, discovered accounts included. Empty = the zero-config host,
   *  which is why it renders as the single-row-per-agent list it always did. */
  accounts: readonly RunnerAccountChoice[]
  /** What the active project's selection resolves to per runner — the row selected until the
   *  surface's own override replaces it. */
  repoAccount?: Partial<Record<Runner, string>> | undefined
}

/**
 * The sign-in state of every NAMED account the listing served without one, so a runner picker can
 * tell whether a runner with a signed-out default account still has a connected account. Asks the
 * same cached per-account query the Accounts pane asks, so the two share one answer.
 */
export function useNamedAccountStatuses(
  profiles: readonly { id: string; provider: string; isDefault: boolean; status?: unknown }[],
): ReadonlyMap<string, ProviderStatus['status']> {
  const missing = profiles.filter((profile) => !profile.isDefault && profile.status === undefined)
  const results = useQueries({
    queries: missing.map((profile) => ({
      queryKey: workspaceQueryKeys.agentAccountStatus(profile.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getAgentAccountStatus(profile.id, { signal }),
      staleTime: 60_000,
      retry: false,
    })),
  })
  const statuses = new Map<string, ProviderStatus['status']>()
  missing.forEach((profile, index) => {
    const status = results[index]?.data?.status?.status
    if (status !== undefined) statuses.set(profile.id, status)
  })
  return statuses
}

/** Resolve one project's account selections, preferring project-id keys (available in hosted mode
 *  without leaking host paths) and falling back to repo-root keys. */
export function selectionForProject(
  data: Pick<AgentProfilesResponse, 'selections'> & { projectSelections?: AgentProfilesResponse['projectSelections'] } | undefined,
  projectId: string | null | undefined,
  repoRoot: string | undefined,
): Partial<Record<Runner, string>> | undefined {
  const byId = data?.projectSelections?.[projectId ?? 'default']
  if (byId !== undefined) return byId as Partial<Record<Runner, string>>
  return (repoRoot ? data?.selections?.[repoRoot] : undefined) as Partial<Record<Runner, string>> | undefined
}

/** Every login for every runner, each with its sign-in state: the listing's cached answer, else
 *  the per-account status route's. Workspace-wide: it reads no project. */
export function useAccountSignIns(): RunnerAccountChoice[] {
  const profiles = useAgentProfiles()
  const listed = profiles.data?.profiles ?? []
  const probed = useNamedAccountStatuses(listed)
  return listed.map((profile) => {
    const status = profile.status?.status ?? probed.get(profile.id)
    return {
      provider: profile.provider as Runner,
      id: profile.id,
      label: profile.label,
      ...(profile.configDir === undefined ? {} : { configDir: profile.configDir }),
      isDefault: profile.isDefault,
      ...(status === undefined ? {} : { status }),
    }
  })
}

export function useAgentAccounts(projectId?: string): AgentAccountChoices {
  const profiles = useAgentProfiles()
  const scope = useProjectScope()
  const repo = useRepo(projectId)
  const accounts = useAccountSignIns()
  const repoRoot = repo.data?.info?.root
  return {
    accounts,
    repoAccount: selectionForProject(profiles.data, projectId ?? scope.projectId, repoRoot),
  }
}

/** Does `runner` have a choice of login to make at all? One login is not a choice. */
export function hasAccountChoice(
  accounts: readonly RunnerAccountChoice[],
  runner: Runner,
): boolean {
  return accounts.filter((choice) => choice.provider === runner).length > 1
}

/**
 * Which runners a start picker offers, and with which accounts (hearsay-tools/squawk#4116).
 *
 * The provider-status row speaks for the DEFAULT account only, so it cannot say alone whether a
 * runner can run: a runner whose default account is signed out is still usable when another of its
 * accounts is connected. Every start surface reads this one answer, so none of them can drop such a
 * runner or start a task on a signed-out account.
 */
export interface RunnerAvailability extends AgentAccountChoices {
  /** Enabled, installed, and signed in on at least one account. */
  runners: Runner[]
  /** Registered runners whose CLI is missing: links to their Settings card. */
  uninstalled: Runner[]
  /** Enabled and installed, but no account is signed in: links to their Settings card. */
  signedOut: Runner[]
  /** The accounts a picker may offer as rows: none known to be signed out. */
  accounts: readonly RunnerAccountChoice[]
  /** The `agentProfile` a start on `runner` sends; `null` follows the project's selection. */
  accountFor: (runner: Runner, picked: string | null | undefined) => string | null
  /** For a surface that cannot send an account: the runners ready on the account it will use. */
  runnersOn: (accountOf: (runner: Runner) => string | undefined) => { runners: Runner[]; signedOut: Runner[] }
  /** Whether `runner` is enabled, installed and ready on the account `accountId` names. */
  readyOn: (runner: Runner, accountId: string | undefined) => boolean
}

export function useRunnerAvailability(projectId?: string): RunnerAvailability {
  const providers = useProviderStatus()
  const registered = useRunners()
  const { accounts, repoAccount } = useAgentAccounts(projectId)
  return {
    runners: usableRunners(providers.data, registered.data, accounts),
    uninstalled: uninstalledRunners(providers.data, registered.data),
    signedOut: signedOutRunners(providers.data, registered.data, accounts),
    accounts: runnableAccounts(providers.data, accounts),
    repoAccount,
    accountFor: (runner, picked) => runnableAccount(providers.data, accounts, runner, picked, repoAccount),
    runnersOn: (accountOf) => runnersOnAccount(providers.data, registered.data, accounts, accountOf),
    readyOn: (runner, accountId) => runnerReadyOn(providers.data, accounts, runner, accountId),
  }
}
