import { SettingsSelect } from './settings-select'
import { canonicalRunnerName } from './agent-descriptors'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IdCardIcon } from 'lucide-react'
import { CpuIcon } from '@/components/design-icons'
import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import { ApiError, putWorkspaceConfig } from '@/api/client'

import {
  useAgentProfiles,
  useHealth,
  useAgentAccountStatus,
  useConnectAgentAccount,
  useRecheckAgentAccount,
  useProviderStatus,
  useRemoveAgentProfile,
  useRunnerModelCatalogs,
  useUpdateAgentProfile,
  useWorkspaceConfig,
  workspaceQueryKeys,
} from '@/api/queries'
import {
  agentAccountRouteId,
  type AgentProfile,
  type AgentProfilesResponse,
} from '@open-mercato/cezar-api-client/contract/agent-profiles'
import type { RunnerEntry, RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import { planRunner, runnerDisplayName, runnerEntry, runnerIds, useRunners } from '@/api/runners'
import { agentCardId } from '@/lib/agents-settings-path'
import type {
  BackendCheck,
  ProviderId,
  Runner,
  SetWorkspaceConfigInput,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { toast } from '@/components/ui/toaster'
import { agentPickerRows } from '@/components/default-agent-picker'
import { catalogQueryStatus, modelsForRunner } from '@/routes/new-task-form'
import { AddAccountDialog } from './add-account-dialog'
import { BrowserSignInButton } from './browser-sign-in'
import { ManagedCli } from './managed-cli'
import { REMOTE_SETTINGS_ENABLE_COMMAND, RemoteSettingsNotice, useSettingsAdminRefresh } from './remote-settings-notice'

import { SettingsAgentPicker } from './settings-agent-picker'

/**
 * Global settings → Agents (spec `.ai/specs/2026-07-29-agent-profiles.md`,
 * hearsay-tools/squawk#4094).
 *
 * One card per registered runner, because the questions a reader has are per agent — is it
 * installed, which version, am I signed in, which folder, and which logins do I have. Each card
 * has an id (`agentCardId`), so the runner picker and the Tools menu link straight to it.
 *
 * Global, for the same reason Projects and Resources are: the binaries and the config dirs
 * describe the person and the machine, never a repo.
 *
 * Permissions follow the server: account rows, Add, Rename and Remove need an editable listing
 * (local only, ADR 0055); managed install and browser sign-in need `settingsAdmin`. A hosted
 * cockpit shows the same cards without what those rules withhold.
 *
 * Rename and Remove live in the account card's action row. Remove requires confirmation. The
 * page shows no account identity: who a login is signed in as never crosses the boundary
 * `provider-auth.ts` keeps.
 *
 * ## Three decisions worth reading
 *
 * 1. **The discovered account is listed but not editable.** It is what `agentHomePaths()` finds —
 *    which honours the vendors' own env vars — so it is a fact, not a setting.
 * 2. **A folder that does not exist yet is not an error.** The documented flow is *add the account
 *    → Connect → the CLI creates the folder*. What must NOT happen is falling back to another
 *    account at run time, and that refusal lives server-side.
 * 3. **Remove only ever DEREGISTERS.** No directory is touched, no session deleted. The confirm
 *    says so out loud, because "Remove" next to a path reads as "delete my folder".
 */

/** Same vocabulary the Providers card uses — one wording for "is this logged in?". */
const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  disconnected: { label: 'Not connected', tone: 'pending' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Could not verify', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: StatusDotTone }>

export function GlobalAgentsSection() {
  const profiles = useAgentProfiles()
  const runners = useRunners()

  if (profiles.isPending || runners.isPending) {
    return (
      <p data-slot="accounts-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agents…
      </p>
    )
  }
  const error = profiles.error ?? runners.error
  if (error) {
    return (
      <CenteredState
        icon={<IdCardIcon />}
        tone="danger"
        title="Agents did not load"
        subtitle={error.message}
        heading="h2"
      />
    )
  }
  return <AgentsPane data={profiles.data!} runners={runners.data!} />
}

/** A config folder for display: the home folder as `~`, and a long path cut to its last three
 *  segments. The full path stays in the element's `title`. */
function shortPath(path: string): string {
  const home = path.replace(/^\/(?:home|Users)\/[^/]+/, '~')
  const parts = home.split('/')
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : home
}

/** Scroll to the card a link named (`#agent-<id>`) once the cards exist. The router does not
 *  scroll to a hash on client navigation, so a link from the runner picker would land at the
 *  top of the page without this. */
function useScrollToCard() {
  const { hash } = useLocation()
  useEffect(() => {
    if (!hash) return
    const card = document.getElementById(decodeURIComponent(hash.slice(1)))
    if (!card) return
    card.scrollIntoView?.({ block: 'start' })
    card.focus({ preventScroll: true })
  }, [hash])
}

function AgentsPane({ data, runners }: { data: AgentProfilesResponse; runners: RunnersResponse }) {
  const health = useHealth()
  const [adding, setAdding] = useState<ProviderId | null>(null)
  const [confirming, setConfirming] = useState<AgentProfile | null>(null)
  const remove = useRemoveAgentProfile()
  useScrollToCard()
  useSettingsAdminRefresh()

  return (
    <div
      data-slot="accounts-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <RemoteSettingsNotice risk="Agent accounts run each CLI with the configured host folder" />
      {data.editable ? null : (
        <p data-slot="accounts-hosted" className="text-[13px] text-soft-foreground">
          Agent accounts are read-only on this remote cockpit. Run{' '}
          <code>{REMOTE_SETTINGS_ENABLE_COMMAND}</code> on the host to add, edit, or sign in to accounts here.
        </p>
      )}

      {/* Every agent gets a card, including one that cannot carry a second login: the card is
          where its install state lives, and hiding OpenCode would just move the question
          "is OpenCode set up?" somewhere else. */}
      <div data-slot="agent-cards" className="flex flex-col gap-4">
        {runners.runners.map((entry) => (
          <AgentCard
            key={entry.id}
            entry={entry}
            // `checks` is read defensively: health is also patched in place from the WS topic and
            // seeded by route gates, so a partially-populated cache entry is a real state — and
            // "Checking…" is the honest thing to show for it.
            check={health.data?.checks?.find((c) => c.name === entry.id)}
            settingsAdmin={health.data?.capabilities?.settingsAdmin === true}
            runners={runners}
            editable={data.editable}
            accounts={data.profiles.filter((p) => p.provider === entry.id)}
            canCarryAccounts={data.profileCapableProviders.includes(entry.id)}
            onAdd={() => setAdding(entry.id)}
            onRemove={setConfirming}
          />
        ))}
      </div>

      <DefaultsForNewProjects runners={runners} />

      {/* Keyed by provider so reopening under a different agent starts from a clean form rather
          than the previous agent's half-typed folder. */}
      {adding !== null ? (
        <AddAccountDialog
          key={adding}
          open
          onOpenChange={(open) => !open && setAdding(null)}
          providers={data.profileCapableProviders}
          initialProvider={adding}
        />
      ) : null}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent data-slot="accounts-remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{confirming?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This only forgets the account. Nothing in {confirming?.configDir ?? 'this account’s folder'} is deleted — not
              your login, not your sessions. Projects using it fall back to the default account,
              and tasks that ran under it can no longer be resumed from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-action="accounts-remove-confirm"
              disabled={remove.isPending}
              onClick={() => {
                const target = confirming
                if (!target) return
                remove.mutate(target.id, {
                  onSuccess: () => {
                    setConfirming(null)
                    toast(`Removed ${target.label}`)
                  },
                  // The server's own words: a 409 explains something this pane cannot infer.
                  onError: (error) => toast(error.message, { tone: 'danger' }),
                })
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The host check, inline in the card's summary: Checking…, Installed (version), or Not installed
 *  with the install hint. */
function InstallReadout({ entry, check }: { entry: RunnerEntry; check: BackendCheck | undefined }) {
  if (check === undefined) return <span data-slot="agent-installed">Checking…</span>
  if (!check.available) {
    return (
      <span data-slot="agent-installed">
        Not installed{entry.installHint ? <> — <code className="break-all">{entry.installHint}</code></> : null}
      </span>
    )
  }
  return (
    <span className="whitespace-nowrap">
      <span data-slot="agent-installed">Installed</span>
      {check.version ? <> <span className="text-soft-foreground">(<span data-slot="agent-version">{check.version}</span>)</span></> : null}
    </span>
  )
}

/** Inline summary items joined by a quiet middle dot. `null` items are skipped. */
function SummaryLine({ items }: { items: ReactNode[] }) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false)
  if (shown.length === 0) return null
  return (
    <p data-slot="agent-summary" className="settings-agent-summary">
      {shown.map((item, index) => (
        <span key={index} className="settings-agent-summary-item">
          {index > 0 ? <span aria-hidden="true" className="settings-agent-summary-sep">·</span> : null}
          {item}
        </span>
      ))}
    </p>
  )
}

/** The card's top row: name and inline summary on the left, compact actions on the right. */
function AgentHead({ titleId, title, summary, actions, actionsSlot }: {
  titleId: string
  title: string
  summary: ReactNode[]
  actions: ReactNode
  actionsSlot: 'account-actions' | 'accounts-actions'
}) {
  return (
    <div data-slot="agent-head" className="settings-agent-head">
      <div className="settings-agent-heading">
        <h3 id={titleId} className="settings-account-provider-title">{title}</h3>
        <SummaryLine items={summary} />
      </div>
      {actions ? <div data-slot={actionsSlot} className="settings-account-actions">{actions}</div> : null}
    </div>
  )
}

/** What the card shows about the agent itself, shared by every login of the same CLI. */
interface AgentFacts {
  titleId: string
  title: string
  /** The install readout and the account count; `null` entries are skipped. */
  facts: ReactNode[]
  /** Add account, when this agent can carry another login here. */
  addButton: ReactNode
}

/** One agent, flattened into a single card: a top row with the name, an inline status summary and
 *  the actions, then one quiet metadata line per account. The first account's status and actions
 *  ride in the top row, because for most agents it is the only login and a second box around it
 *  only cost height. */
function AgentCard({
  entry,
  check,
  settingsAdmin,
  runners,
  editable,
  accounts,
  canCarryAccounts,
  onAdd,
  onRemove,
}: {
  entry: RunnerEntry
  /** The `/api/v1/health` probe for this CLI — the ONE place a version can honestly come from. */
  check: BackendCheck | undefined
  settingsAdmin: boolean
  runners: RunnersResponse
  /** The account listing is editable: local cockpit or host-granted remote settings admin (ADR 0055). */
  editable: boolean
  accounts: AgentProfile[]
  canCarryAccounts: boolean
  onAdd: () => void
  onRemove: (account: AgentProfile) => void
}) {
  const provider = entry.id
  const title = canonicalRunnerName(entry.id, entry.displayName)
  // The managed installer reports its own installed and latest versions; it renders only under
  // `settingsAdmin`, so without that grant the host check is the readout.
  const managed = entry.managedInstall === true && settingsAdmin
  const discoveredCount = accounts.filter((account) => account.isDefault).length
  const titleId = `${agentCardId(provider)}-title`
  const addButton = editable && canCarryAccounts
    ? <Button type="button" variant="outline" size="sm" data-action="accounts-add" data-provider={provider} onClick={onAdd}>Add account</Button>
    : null
  const agent: AgentFacts = {
    titleId,
    title,
    facts: [
      managed ? null : <InstallReadout entry={entry} check={check} />,
      editable || accounts.length > 0 ? (
        <span
          className="settings-account-count"
          title={`${discoveredCount} discovered, ${accounts.length - discoveredCount} added`}
        >
          {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
        </span>
      ) : null,
    ],
    addButton,
  }
  const [primary, ...others] = accounts

  return (
    <section
      id={agentCardId(provider)}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-slot="accounts-provider"
      data-provider={provider}
      className="settings-agent-card flex flex-col rounded-lg border border-border bg-card"
    >
      {primary === undefined ? (
        <AgentHead titleId={titleId} title={title} summary={agent.facts} actions={addButton} actionsSlot="accounts-actions" />
      ) : null}
      {managed ? <ManagedCli runner={provider} /> : null}
      {primary !== undefined ? (
        <ul className="settings-agent-accounts">
          <AccountRow
            account={primary}
            runners={runners}
            editable={editable}
            onRemove={() => onRemove(primary)}
            agent={agent}
          />
          {others.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              runners={runners}
              editable={editable}
              onRemove={() => onRemove(account)}
            />
          ))}
        </ul>
      ) : null}
      {editable && !canCarryAccounts ? (
        <p data-slot="accounts-single-only" className="settings-agent-note">
          One account only: {title} keeps its login outside its config folder, so a second folder
          would change settings without changing who is billed.
        </p>
      ) : !editable && accounts.length === 0 && entry.browserLogin ? (
        // Fallback for older servers that withhold account rows in hosted mode.
        <div data-slot="hosted-sign-in" className="settings-agent-note flex flex-wrap items-center gap-3">
          <span>Discovered account</span>
          <BrowserSignInButton provider={provider} label={title} />
        </div>
      ) : null}
    </section>
  )
}

/**
 * The runner and model a project that has chosen nothing runs. On this page because it is the same
 * subject as the agents above. DEFAULTS, never overrides: a project's own `.ai/cezar/config.json`
 * still wins key by key. Which account a project uses is that project's own setting.
 */
function DefaultsForNewProjects({ runners }: { runners: RunnersResponse }) {
  const [modelRunner, setModelRunner] = useState<Runner | null>(null)
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const providerStatus = useProviderStatus()
  // Keep each host catalog available while the model-agent chooser switches (#794).
  const catalogs = useRunnerModelCatalogs(runnerIds(runners))
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (config.data === undefined) return null

  // One row per agent: an account is a project's choice, never a machine-wide one.
  const rows = agentPickerRows([], runners)
  // Absent means "no opinion", and the built-in fallback is claude — the same answer a project with
  // no config gets today. Showing it checked is honest: it IS what an unconfigured project runs.
  const runner = config.data.agentDefaults.runner ?? 'claude'
  const modelChoice = planRunner(modelRunner ?? runner, runnerIds(runners)) ?? (modelRunner ?? runner)
  const models = config.data.agentDefaults.models ?? {}

  return (
    <section data-slot="accounts-defaults" className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3.5">
      <div>
        <h3 className="text-[13px] font-semibold text-foreground">Defaults for new projects</h3>
        <p className="text-[13px] text-muted-foreground">
          What a project runs when it has not chosen for itself — set once instead of per
          repository. A project that has chosen keeps its own.
        </p>
      </div>

      <SettingsAgentPicker
        rows={rows}
        runner={runner}
        accountFor={() => null}
        providerStatus={providerStatus}
        disabled={save.isPending}
        onPick={(picked) => {
          if (picked !== runner) save.mutate({ agentDefaults: { runner: picked } })
        }}
      />

      <div className="settings-account-models flex flex-col gap-2">
        <label className="settings-model-agent-choice">
          <span>Default model for</span>
          <SettingsSelect aria-label="Model agent" value={modelChoice} onChange={(event) => setModelRunner(event.target.value as Runner)}>
            {runners.runners.map((entry) => <option key={entry.id} value={entry.id}>{canonicalRunnerName(entry.id, entry.displayName)}</option>)}
          </SettingsSelect>
        </label>
        {runners.runners.filter((entry) => entry.id === modelChoice).map((entry) => (
          <label key={entry.id} className="settings-account-model flex flex-wrap items-center gap-3">
            <CpuIcon className="size-4 text-accent-icon shrink-0" />
            <span className="w-28 shrink-0 text-xs text-muted-foreground">{canonicalRunnerName(entry.id, entry.displayName)}</span>
            <SettingsSelect
              aria-label={`Default model for ${entry.pickerLabel}`}
              data-slot="accounts-default-model"
              data-runner={entry.id}
              value={models[entry.id] ?? ''}
              disabled={save.isPending}
              onChange={(event) =>
                save.mutate({
                  // `null` clears the key back to "no opinion" — absence cannot say that in a
                  // partial patch, and a stale value would keep seeding every unconfigured project.
                  agentDefaults: {
                    models: { [entry.id]: event.target.value || null } as Partial<
                      Record<Runner, string | null>
                    >,
                  },
                })
              }
              className="block w-64 max-w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {modelsForRunner(entry.id, runners, catalogs[entry.id]?.data, [models[entry.id]]).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id === '' ? 'Native default' : model.label}
                </option>
              ))}
              <CatalogStatusOption runner={entry.id} runners={runners} catalog={catalogs[entry.id]} />
            </SettingsSelect>
          </label>
        ))}
      </div>
    </section>
  )
}

/** The model catalog's status line as a disabled option, when there is one to show. */
function CatalogStatusOption({ runner, runners, catalog }: {
  runner: Runner
  runners: RunnersResponse
  catalog: ReturnType<typeof useRunnerModelCatalogs>[string] | undefined
}) {
  const status = catalogQueryStatus(runner, runners, catalog)
  return status ? <option disabled>{status}</option> : null
}

function AccountSignIn({ account, runners, status, editable }: {
  account: AgentProfile; runners: RunnersResponse; status: AgentProfile['status']; editable: boolean
}) {
  const connect = useConnectAgentAccount()
  return <>
          {status && status.status !== 'connected' && runnerEntry(runners, account.provider)?.browserLogin ? (
            <BrowserSignInButton provider={account.provider} {...(account.isDefault ? {} : { profileId: account.id })} label={account.label} />
          ) : null}
          {editable && status && status.status !== 'connected' && runnerEntry(runners, account.provider)?.terminalLogin !== false ? (
            <Button
              type="button"
              size="sm"
              data-action="account-connect"
              disabled={connect.isPending}
              onClick={() =>
                connect.mutate(
                  { provider: account.provider, ...(account.isDefault ? {} : { profileId: account.id }) },
                  {
                    onSuccess: (result) =>
                      toast(result.opened
                        ? 'Finish signing in in the terminal, then Check again.'
                        : 'This account is already connected.'),
                    // The server answers a copyable command when it cannot open a terminal (hosted
                    // mode, no emulator, a folder it refuses to embed). Showing it is the whole
                    // point of failing closed rather than running the bare login.
                    onError: (error: Error) =>
                      toast(error instanceof ApiError && error.command
                        ? `${error.message} — run: ${error.command}`
                        : error.message, { tone: 'danger' }),
                  },
                )
              }
            >
              Connect
            </Button>
          ) : null}
  </>
}

function AccountFolderAdvisory({ account, runners, status, editable }: {
  account: AgentProfile; runners: RunnersResponse; status: AgentProfile['status']; editable: boolean
}) {
  if (!status || status.requiresAccountHome === false) return null
  if (!account.exists) {
    return (
      <span data-slot="account-missing">
        {editable
          ? status.status === 'connected'
            ? '— folder not created yet; use Check again to refresh'
            : '— folder not created yet; Connect will make it'
          : '— not initialized on host yet'}
      </span>
    )
  }
  if (!account.looksValid && account.configDir) {
    return (
      <span data-slot="account-unrecognised">
        — this folder does not look like {canonicalRunnerName(account.provider, runnerDisplayName(runners, account.provider))} config yet
      </span>
    )
  }
  return null
}

function AccountRow({ account, runners, editable, onRemove, agent }: {
  account: AgentProfile; runners: RunnersResponse; editable: boolean; onRemove: () => void
  /** Set on the agent's first account: this row also renders the card's top row, so the account's
   *  status and Check again sit beside the agent name instead of in a box of their own. */
  agent?: AgentFacts
}) {
  const routeId = agentAccountRouteId(account)
  const recheck = useRecheckAgentAccount()
  // The listing carries a status whenever the server has one cached — which, after its boot warm,
  // is the normal case. Only ask for a probe when it does not: an account added mid-session, or a
  // cache that has aged out. Either way the row renders immediately.
  const probed = useAgentAccountStatus(routeId, account.status === undefined)
  const status = account.status ?? probed.data?.status
  const presentation = status ? STATUS_PRESENTATION[status.status] : undefined

  // "Checking…" is a real, distinct state from any probe RESULT: the answer is not in yet.
  // Showing `unknown` here would claim a verification that never ran.
  const statusReadout = (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot tone={presentation?.tone ?? 'neutral'} pulse={presentation === undefined} />
      <span data-slot="account-status" className="text-foreground">{presentation?.label ?? 'Checking…'}</span>
    </span>
  )
  const actions = (
    <>
      <AccountSignIn account={account} runners={runners} status={status} editable={editable} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-action="account-recheck"
        disabled={recheck.isPending}
        title="Re-probe this account's login now, instead of waiting for the cached answer"
        onClick={() =>
          recheck.mutate(routeId, {
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          })
        }
      >
        Check again
      </Button>
    </>
  )
  const name = (
    <>
      <span className="settings-account-label">{account.label}</span>
      {account.isDefault ? (
        <Badge variant="ghost" className="shrink-0 text-[11px] text-muted-foreground">
          discovered
        </Badge>
      ) : null}
    </>
  )
  const path = account.configDir ? (
    <span data-slot="account-path" className="settings-account-path" title={account.path}>
      {shortPath(account.configDir)}
    </span>
  ) : null
  const hint = status?.hint ? <p className="settings-account-hint">{status.hint}</p> : null
  const manage = editable && !account.isDefault ? <AccountManagement account={account} onRemove={onRemove} /> : null

  if (agent) {
    return (
      <li data-slot="account-row" data-account={account.id} data-primary="" className="settings-account-primary">
        <AgentHead
          titleId={agent.titleId}
          title={agent.title}
          summary={[statusReadout, ...agent.facts]}
          actions={<>{actions}{agent.addButton}</>}
          actionsSlot="account-actions"
        />
        {/* The metadata line: which login this is and where it lives, then the advisory. */}
        <div className="settings-account-meta">
          <div className="settings-account-readout">
            <div className="settings-account-meta-line">
              {name}
              {path}
              <AccountFolderAdvisory account={account} runners={runners} status={status} editable={editable} />
            </div>
            {hint}
          </div>
          {manage ? <div className="settings-account-actions">{manage}</div> : null}
        </div>
      </li>
    )
  }

  return (
    <li data-slot="account-row" data-account={account.id} className="settings-account-line">
      <div className="settings-account-readout">
        {/* Status leads the line; the folder follows on its own, so a long path never squeezes it. */}
        <div className="settings-account-meta-line">
          {name}
          <span aria-hidden="true" className="settings-agent-summary-sep">·</span>
          {statusReadout}
          <AccountFolderAdvisory account={account} runners={runners} status={status} editable={editable} />
        </div>
        {path}
        {hint}
      </div>
      <div data-slot="account-actions" className="settings-account-actions">
        {actions}
        {manage}
      </div>
    </li>
  )
}

/** Account actions do not fetch identity; Remove still opens the existing confirmation. */
function AccountManagement({ account, onRemove }: { account: AgentProfile; onRemove: () => void }) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.label)
  const rename = useUpdateAgentProfile()
  return <>
      {/* The discovered account carries no Rename/Remove at all — it is what cezar found, so either
          would imply a setting that does not exist. Nothing is rendered for it, not a disabled
          control, because a greyed-out Remove reads as "not allowed yet" rather than "not a thing". */}
      {account.isDefault ? null : (
        <div
          data-slot="account-manage"
          className="settings-account-management"
        >
          {renaming ? (
            <>
              <input
                type="text"
                autoFocus
                aria-label={`Name for ${account.label}`}
                data-slot="account-rename-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="w-48 rounded-md border border-input bg-card px-2 py-1 text-xs outline-none focus-visible:border-ring"
              />
              <Button
                type="button"
                size="sm"
                data-action="account-rename-save"
                disabled={rename.isPending || draft.trim() === '' || draft.trim() === account.label}
                onClick={() =>
                  rename.mutate(
                    { id: account.id, label: draft.trim() },
                    {
                      onSuccess: () => setRenaming(false),
                      onError: (error) => toast(error.message, { tone: 'danger' }),
                    },
                  )
                }
              >
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(account.label)
                  setRenaming(false)
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="account-rename"
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="account-remove"
                onClick={onRemove}
              >
                Remove account
              </Button>
              {/* The label is cezar's own; the folder is the account. Saying so here is what keeps
                  Rename from reading as "point this at a different directory". */}
              <span className="text-xs text-muted-foreground">
                Renaming changes what Squawk calls this account, not its folder.
              </span>
            </>
          )}
        </div>
      )}
  </>
}
