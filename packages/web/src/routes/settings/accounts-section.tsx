import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IdCardIcon } from 'lucide-react'
import { CpuIcon } from '@/components/design-icons'
import { useState } from 'react'

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
import { runnerSchema } from '@open-mercato/cezar-api-client/contract/runner'
import { runnerDisplayName } from '@open-mercato/cezar-api-client/contract/runner-facts'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { agentPickerRows } from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { AddAccountDialog } from './add-account-dialog'

import { SettingsAgentPicker } from './settings-agent-picker'

/**
 * Global settings → Agent accounts (spec `.ai/specs/2026-07-29-agent-profiles.md`).
 *
 * One tab per agent, because the questions a reader has are per agent — is it installed, which
 * version, am I signed in, which folder, and which logins do I have. Stacking every agent on one
 * scroll made the answer to "what's up with Codex" something you had to hunt for.
 *
 * Global, for the same reason Projects and Resources are: a config dir describes the person and
 * the machine, never a repo.
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

/** The vendor's own install/login instruction, shown when the CLI is not on this machine. */
const PROVIDER_INSTALL: Record<ProviderId, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  opencode: 'https://opencode.ai',
  pi: 'https://github.com/badlogic/pi-mono',
  omp: 'https://omp.sh',
}

/** Same vocabulary the Providers card uses — one wording for "is this logged in?". */
const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  disconnected: { label: 'Not connected', tone: 'pending' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Could not verify', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: StatusDotTone }>

export function AccountsSection() {
  const profiles = useAgentProfiles()

  if (profiles.isPending) {
    return (
      <p data-slot="accounts-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent accounts…
      </p>
    )
  }
  if (profiles.isError) {
    return (
      <CenteredState
        icon={<IdCardIcon />}
        tone="danger"
        title="Agent accounts did not load"
        subtitle={profiles.error.message}
        heading="h2"
      />
    )
  }
  return <AccountsPane data={profiles.data} />
}

function AccountsPane({ data }: { data: AgentProfilesResponse }) {
  const health = useHealth()
  const [adding, setAdding] = useState<ProviderId | null>(null)
  const [confirming, setConfirming] = useState<AgentProfile | null>(null)
  const remove = useRemoveAgentProfile()

  // Every agent gets a tab, including one that cannot carry a second login: the tab is where its
  // install state and config folder live, and hiding OpenCode would just move the question
  // "is OpenCode set up?" somewhere else.
  const providers: readonly ProviderId[] = runnerSchema.options

  if (!data.editable) {
    return (
      <div
        data-slot="accounts-section"
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6"
      >

        <p data-slot="accounts-hosted" className="text-[13px] text-soft-foreground">
          Agent accounts are managed from the machine that owns the checkout — this cockpit runs in
          hosted mode.
        </p>
      </div>
    )
  }

  return (
    <div
      data-slot="accounts-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <div>

        <p className="text-[13px] text-muted-foreground">
          Manage runner installations, logins and defaults for new projects.
        </p>
      </div>

      <Tabs defaultValue="claude">
        <TabsList variant="line" data-slot="accounts-tabs">
          {providers.map((provider) => (
            <TabsTrigger key={provider} value={provider} data-provider={provider}>
              {runnerDisplayName(provider)}
            </TabsTrigger>
          ))}
        </TabsList>

        {providers.map((provider) => (
          <TabsContent key={provider} value={provider} className="pt-4">
            <AgentTab
              provider={provider}
              // `checks` is read defensively: health is also patched in place from the WS topic and
              // seeded by route gates, so a partially-populated cache entry is a real state — and
              // "Checking…" is the honest thing to show for it.
              check={health.data?.checks?.find((c) => c.name === provider)}
              accounts={data.profiles.filter((p) => p.provider === provider)}
              canCarryAccounts={data.profileCapableProviders.includes(provider)}
              onAdd={() => setAdding(provider)}
              onRemove={setConfirming}
            />
          </TabsContent>
        ))}
      </Tabs>

      <DefaultsForNewProjects />

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
              This only forgets the account. Nothing in {confirming?.configDir} is deleted — not
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

/** One agent: what the machine has, then the logins configured for it. */
function AgentTab({
  provider,
  check,
  accounts,
  canCarryAccounts,
  onAdd,
  onRemove,
}: {
  provider: ProviderId
  /** The `/api/v1/health` probe for this CLI — the ONE place a version can honestly come from. */
  check: BackendCheck | undefined
  accounts: AgentProfile[]
  canCarryAccounts: boolean
  onAdd: () => void
  onRemove: (account: AgentProfile) => void
}) {
  const installed = check?.available === true
  const discoveredCount = accounts.filter((account) => account.isDefault).length

  return (
    <div data-slot="accounts-provider" data-provider={provider} className="flex flex-col gap-4">
      {/* Facts about the BINARY, not about any one account: a version and an install are shared by
          every login of the same CLI, so they belong here rather than repeated on each row. */}
      <h3 className="settings-account-provider-title">{runnerDisplayName(provider)}</h3>
      <div className="settings-account-installation settings-readout">
        {check === undefined ? <span>Checking…</span> : installed ? (
          <span data-slot="agent-installed">Installed</span>
        ) : (
          <span data-slot="agent-installed">Not installed — <code>{PROVIDER_INSTALL[provider]}</code></span>
        )}
        {installed && check?.version ? <><span aria-hidden="true"> · </span><span data-slot="agent-version">{check.version}</span></> : null}
        <span className="settings-account-count">{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} ({discoveredCount} discovered, {accounts.length - discoveredCount} added)</span>
      </div>

      <ul className="bg-card">
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} onRemove={() => onRemove(account)} />
        ))}
      </ul>

      {canCarryAccounts ? (
        <div className="settings-account-add-row">
          <Button type="button" variant="outline" size="sm" data-action="accounts-add" data-provider={provider} onClick={onAdd}>Add account</Button>
        </div>
      ) : null}

      {!canCarryAccounts ? (
        <p data-slot="accounts-single-only" className="text-[11px] text-soft-foreground">
          {runnerDisplayName(provider)} can only hold one account here: it keeps its credentials
          outside its config folder, so a second folder would change settings without changing the
          login — which would say “work account” while billing the other one.
        </p>
      ) : null}
    </div>
  )
}

/**
 * The runner and model a project that has chosen nothing runs. On this page because it is the same
 * subject as the agents above. DEFAULTS, never overrides: a project's own `.ai/cezar/config.json`
 * still wins key by key. Which account a project uses is that project's own setting.
 */
function DefaultsForNewProjects() {
  const [modelRunner, setModelRunner] = useState<Runner | null>(null)
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const providerStatus = useProviderStatus()
  // Keep each host catalog available while the model-agent chooser switches (#794).
  const catalogs = useRunnerModelCatalogs()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (config.data === undefined) return null

  // One row per agent: an account is a project's choice, never a machine-wide one.
  const rows = agentPickerRows([])
  // Absent means "no opinion", and the built-in fallback is claude — the same answer a project with
  // no config gets today. Showing it checked is honest: it IS what an unconfigured project runs.
  const runner = config.data.agentDefaults.runner ?? 'claude'
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
          <select aria-label="Model agent" value={modelRunner ?? runner} onChange={(event) => setModelRunner(event.target.value as Runner)}>
            {RUNNERS.map((entry) => <option key={entry.id} value={entry.id}>{runnerDisplayName(entry.id)}</option>)}
          </select>
        </label>
        {RUNNERS.filter((entry) => entry.id === (modelRunner ?? runner)).map((entry) => (
          <label key={entry.id} className="settings-account-model flex items-center gap-3">
            <CpuIcon className="size-4 text-accent-icon shrink-0" />
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{runnerDisplayName(entry.id)}</span>
            <select
              aria-label={`Default model for ${entry.label}`}
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
              className="block w-full max-w-xs rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {modelsForRunner(entry.id, catalogs[entry.id].data, [models[entry.id]]).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id === '' ? 'Native default' : model.label}
                </option>
              ))}
              {modelCatalogStatus(entry.id, catalogs[entry.id].data, catalogs[entry.id].isError, catalogs[entry.id].isFetching) ? (
                <option disabled>
                  {modelCatalogStatus(entry.id, catalogs[entry.id].data, catalogs[entry.id].isError, catalogs[entry.id].isFetching)}
                </option>
              ) : null}
            </select>
          </label>
        ))}
      </div>
    </section>
  )
}

function AccountRow({ account, onRemove }: { account: AgentProfile; onRemove: () => void }) {
  const routeId = agentAccountRouteId(account)
  const connect = useConnectAgentAccount()
  const recheck = useRecheckAgentAccount()
  // The listing carries a status whenever the server has one cached — which, after its boot warm,
  // is the normal case. Only ask for a probe when it does not: an account added mid-session, or a
  // cache that has aged out. Either way the row renders immediately.
  const probed = useAgentAccountStatus(routeId, account.status === undefined)
  const status = account.status ?? probed.data?.status
  const presentation = status ? STATUS_PRESENTATION[status.status] : undefined

  return (
    <li
      data-slot="account-row"
      data-account={account.id}
      className="flex flex-col gap-2 px-3.5 py-3"
    >
      <div className="settings-account-card">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground">{account.label}</span>
            {account.isDefault ? (
              <Badge variant="ghost" className="shrink-0 text-[12px] text-muted-foreground">
                discovered
              </Badge>
            ) : null}
          </div>
          <div className="settings-account-readout settings-readout">
          <p
            data-slot="account-path"
            className="mt-0.5 truncate font-mono text-[11px] text-soft-foreground"
            title={account.path}
          >
            {account.configDir}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {/* "Checking…" is a real, distinct state from any probe RESULT: the answer is not in
                yet. Showing `unknown` here would claim a verification that never ran. */}
            <StatusDot tone={presentation?.tone ?? 'neutral'} pulse={presentation === undefined} />
            <span data-slot="account-status">{presentation?.label ?? 'Checking…'}</span>
            {!account.exists ? (
              <span data-slot="account-missing">— folder not created yet; Connect will make it</span>
            ) : !account.looksValid ? (
              <span data-slot="account-unrecognised">
                — this folder does not look like {runnerDisplayName(account.provider)} config yet
              </span>
            ) : null}
          </div>
          </div>
        </div>

        {/* Public account actions stay separate from the opt-in identity details below. */}
        <div className="settings-account-actions">
          {status?.status !== 'connected' ? (
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
          <AccountManagement account={account} onRemove={onRemove} />
        </div>
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
