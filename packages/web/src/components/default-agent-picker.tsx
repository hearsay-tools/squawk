import type { AgentProfile, ProviderStatus, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import type { RunnerEntry, RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import { cn } from '@/lib/utils'
import { providerStatusFor } from '@/lib/provider-status'
import { runnerEntries, runnerIds, useRunners } from '@/api/runners'

/**
 * "Which agent, and which of its logins" as ONE flat list (spec 2026-07-29-agent-profiles):
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * The same shape the composer's runner pill uses, and shared by BOTH settings scopes — the repo's
 * default and the machine-wide one are the same question asked about a different subject, so they
 * must not drift into two controls that look alike but behave differently.
 *
 * An agent with a single login stays a single row, which is why a machine with no extra accounts
 * sees exactly the segmented control it always saw.
 */

export interface AgentPickerRow {
  runner: RunnerEntry
  /** `null` is the discovered account — stored as absence, never the reserved `default` id. */
  account: string | null
  label: string
  desc: string
  missing: boolean
  /** A named account's own sign-in state from the listing; absent for the default account (its
   *  state is the provider row) and for an account the server has not probed yet. */
  accountStatus?: ProviderStatus['status'] | undefined
}

/** Build the rows once, so the caller's `checked` logic and the render agree by construction. */
export function agentPickerRows(profiles: readonly AgentProfile[], runners: RunnersResponse | undefined): AgentPickerRow[] {
  return runnerEntries(runners).flatMap((runner) => {
    const logins = profiles.filter((p) => p.provider === runner.id)
    // One login is not a choice, so the agent is the row.
    if (logins.length < 2) {
      return [{ runner, account: null, label: runner.pickerLabel, desc: runner.pickerDescription, missing: false }]
    }
    return logins.map((login) => ({
      runner,
      account: login.isDefault ? null : login.id,
      label: `${runner.pickerLabel} · ${login.label}`,
      // The folder, because the labels are Squawk's invention and the folder is the account. A
      // folder the CLI has not written yet is called out rather than left looking fine: a run under
      // it fails on auth BY DESIGN — it must not quietly fall back to another login — so the place
      // to say so is where the choice is made.
      desc: login.configDir
        ? (login.exists ? login.configDir : `${login.configDir} — folder not created yet`)
        : (login.exists ? '' : 'Not initialized on host yet'),
      missing: !login.exists,
      ...(login.isDefault || login.status === undefined ? {} : { accountStatus: login.status.status }),
    }))
  })
}

/** True once any agent has a second login — what turns the strip into a stacked list. */
export const hasAgentAccounts = (rows: readonly AgentPickerRow[], runners: RunnersResponse | undefined): boolean =>
  rows.length > runnerIds(runners).length

/** The provider status as a picker row reads it: whether the runner can be picked, and why not. */
export function providerChoice(
  providerStatus: { data?: ProviderStatusResponse | undefined; isPending: boolean; isError: boolean },
  runner: Runner,
  accountStatus?: ProviderStatus['status'] | undefined,
): { providerConnected: boolean; providerReason: string | undefined } {
  const provider = providerStatusFor(providerStatus.data, runner)
  // A named account's own state replaces the default account's row (hearsay-tools/squawk#4116).
  const signedIn = provider !== undefined && provider.status !== 'not-installed'
    && (accountStatus ?? provider.status) === 'connected'
  const providerConnected =
    !providerStatus.isPending &&
    !providerStatus.isError &&
    provider?.enabled === true &&
    signedIn
  const providerReason = providerStatus.isPending
    ? 'Checking provider authentication…'
    : providerStatus.isError
      ? 'Provider authentication could not be verified.'
      : provider?.enabled === false
        ? 'This provider is disabled. Enable it above or choose another provider.'
      : providerConnected
        ? undefined
        : 'Connect this provider before selecting it.'
  return { providerConnected, providerReason }
}

export function DefaultAgentPicker({
  rows,
  runner,
  accountFor,
  providerStatus,
  disabled = false,
  accountDisabled = false,
  onPick,
}: {
  rows: readonly AgentPickerRow[]
  runner: Runner
  /** The account currently in force for a runner, or null for the discovered one. */
  accountFor: (runner: Runner) => string | null
  providerStatus: {
    data?: ProviderStatusResponse | undefined
    isPending: boolean
    isError: boolean
  }
  disabled?: boolean
  /** Account rows only: the write target is not known yet (e.g. the project registry is loading). */
  accountDisabled?: boolean
  onPick: (runner: Runner, account: string | null, hasAccountChoice: boolean) => void
}) {
  // Every row waits for the runners list, as it waits for the provider status.
  const registered = useRunners().data
  const runnersPending = registered === undefined
  const stacked = hasAgentAccounts(rows, registered)
  return (
    <div
      role="radiogroup"
      aria-label="Default runner"
      data-slot="agents-runner"
      className={cn(
        'gap-0.5 rounded-md border border-border bg-card p-0.5',
        // Stacked once accounts are in play: `claude · Klaudiusz` beside its folder does not fit a
        // segmented strip, and the folder is the part that says WHICH login this is.
        stacked ? 'flex max-w-md flex-col' : 'inline-flex w-fit',
      )}
    >
      {rows.map((row) => {
        const { providerConnected, providerReason } = providerChoice(providerStatus, row.runner.id, row.accountStatus)
        const hasAccountChoice = rows.filter((other) => other.runner.id === row.runner.id).length > 1
        const checked = row.runner.id === runner && row.account === accountFor(row.runner.id)
        return (
          <button
            key={`${row.runner.id}:${row.account ?? ''}`}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={row.runner.id}
            data-account={row.account ?? ''}
            title={providerReason ?? row.desc}
            disabled={
              disabled || runnersPending || !providerConnected || (hasAccountChoice && accountDisabled)
            }
            onClick={() => onPick(row.runner.id, row.account, hasAccountChoice)}
            className={cn(
              'rounded-sm px-3 py-1.5 text-left font-mono text-[13px] font-medium transition-colors disabled:opacity-50',
              checked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {row.label}
            {stacked ? (
              <span
                data-slot={row.missing ? 'agents-account-missing' : 'agents-account-dir'}
                data-runner={row.runner.id}
                className="ml-2 font-sans text-xs text-soft-foreground"
              >
                {row.desc}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
