import { useMutation, useQueryClient } from '@tanstack/react-query'

import { ApiError, putConfig } from '@/api/client'
import { queryKeys, useHealth } from '@/api/queries'
import {
  WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS,
  WORKTREE_SETUP_MAX_TIMEOUT_SECONDS,
  type ConfigResponse,
  type SetConfigInput,
} from '@open-mercato/cezar-api-client/contract/workspace'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { useUnsentDraft } from '@/lib/version-reload'
import { useSavedDraft } from '@/lib/saved-draft'
import { WorktreeCommandsStatus } from './worktree-commands-status'
import { parseWorktreeSetupInput } from './worktree-setup-input'
import { SettingsField } from './settings-field'
import { useActiveProjectRoot } from './project-location'
import { RemoteSettingsNotice, useSettingsAdminRefresh } from './remote-settings-notice'

type WorktreeCommandsKey = 'worktreeSetup' | 'worktreeTeardown'

/** The words and selectors that differ between the two command lists; everything else is shared. */
export interface WorktreeCommandsCopy {
  key: WorktreeCommandsKey
  issueKey: 'worktreeSetupIssue' | 'worktreeTeardownIssue'
  slot: string
  title: string
  hint: string
  empty: string
  label: string
  example: string
  fileEditApplies: string
  saved: string
  cleared: string
  save: string
}

export const WORKTREE_COMMANDS_COPY: Record<'setup' | 'teardown', WorktreeCommandsCopy> = {
  setup: {
    key: 'worktreeSetup',
    issueKey: 'worktreeSetupIssue',
    slot: 'worktree-setup',
    title: 'Prepare new worktrees',
    hint: 'Runs in every new task and worker worktree before the agent starts, in order, stopping at the first failure. Leave commands empty to skip setup.',
    empty: 'No setup commands configured. No commands will run in new worktrees.',
    label: 'Worktree setup commands, one per line',
    example: 'npm ci',
    fileEditApplies: 'Valid file edits apply to new worktrees.',
    saved: 'Worktree setup saved',
    cleared: 'Worktree setup cleared',
    save: 'Save setup',
  },
  teardown: {
    key: 'worktreeTeardown',
    issueKey: 'worktreeTeardownIssue',
    slot: 'worktree-teardown',
    title: 'Stop worker services before destroy',
    hint: 'Runs in a worker’s worktree when the worker is destroyed, before destroy stops the worker’s processes, in order, stopping at the first failure. A failure is recorded on the worker and destroy goes on. Leave commands empty to skip teardown.',
    empty: 'No teardown commands configured. Destroy runs no commands in worker worktrees.',
    label: 'Worktree teardown commands, one per line',
    example: 'docker compose down',
    fileEditApplies: 'Valid file edits apply to the next worker destroy.',
    saved: 'Worktree teardown saved',
    cleared: 'Worktree teardown cleared',
    save: 'Save teardown',
  },
}

/**
 * Project settings → Worktrees: one command list from `config.json`.
 * - "Prepare new worktrees" (`worktreeSetup`, hearsay-tools/cezarion#917, spec
 *   `.ai/specs/2026-10-07-worktree-setup.md`): runs in every new task and worker worktree before
 *   the agent starts.
 * - "Stop worker services before destroy" (`worktreeTeardown`, hearsay-tools/squawk#914): runs in a
 *   worker's worktree when destroy starts, before destroy stops the worker's processes.
 * One command per line; blank lines are dropped.
 *
 * Editable on a local cockpit, or on a remote one whose host operator ran `cez remote-settings
 * enable` (hearsay-tools/cezarion#2428). These are commands the host runs, so any other cockpit
 * shows them read-only and the server refuses the write (409) whatever the client does.
 */
export function WorktreeCommandsField({ config, copy }: { config: ConfigResponse; copy: WorktreeCommandsCopy }) {
  const queryClient = useQueryClient()
  const health = useHealth()
  const refreshSettingsAdmin = useSettingsAdminRefresh()
  const projectRoot = useActiveProjectRoot()
  const configPath = projectRoot === null ? null : `${projectRoot.replace(/\/$/, '')}/.ai/cezar/config.json`
  // Unknown until health answers: read-only rather than editable-then-refused.
  const editable = health.data?.capabilities?.settingsAdmin === true

  const saved = config[copy.key]
  const issue = config[copy.issueKey]
  const savedCommands = saved?.commands ?? []
  const savedTimeout = saved?.timeoutSeconds ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS
  const [text, setText] = useSavedDraft(savedCommands.join('\n'))
  const [timeoutText, setTimeoutText] = useSavedDraft(String(savedTimeout))

  const { commands, timeoutSeconds, invalid } = parseWorktreeSetupInput(text, timeoutText)
  const matchesSaved =
    commands.length === savedCommands.length &&
    commands.every((command, index) => command === savedCommands[index]) &&
    (commands.length === 0 || timeoutSeconds === savedTimeout)
  // An invalid value on disk is a change to make even when the box matches "nothing saved".
  const unchanged = issue === null && matchesSaved
  useUnsentDraft(editable && !matchesSaved)

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.config, result)
      setText(commands.join('\n'))
      toast(commands.length === 0 ? copy.cleared : copy.saved)
    },
    onError: (error: Error) => {
      toast(error.message, { tone: 'danger' })
      // A 409 can mean the host withdrew the grant since the page loaded: show the field read-only.
      if (error instanceof ApiError && error.status === 409) void refreshSettingsAdmin()
    },
  })
  const submit = () =>
    save.mutate({
      [copy.key]:
        commands.length === 0
          ? null
          : {
              commands,
              // The default is never written into config.json (it stays a default).
              ...(timeoutSeconds === WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS ? {} : { timeoutSeconds }),
            },
    })

  const control =
    'block rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 read-only:bg-muted read-only:text-muted-foreground'

  return (
    <SettingsField
      title={copy.title}
      hint={copy.hint}
    >
      <RemoteSettingsNotice risk={`These commands run on the machine running Squawk`} />
      <WorktreeCommandsStatus
        copy={copy}
        savedCommandCount={savedCommands.length}
        settingsAdmin={health.data?.capabilities?.settingsAdmin}
        configPath={configPath}
        issue={issue}
        invalid={invalid}
      >
        <textarea
          data-slot={`${copy.slot}-commands`}
          data-reports-dirty=""
          aria-label={copy.label}
          rows={4}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={text}
          readOnly={!editable}
          disabled={save.isPending}
          onChange={(event) => setText(event.target.value)}
          className={`${control} min-h-24 w-full resize-y font-mono text-[13px] leading-relaxed`}
        />
        <p className="text-xs text-soft-foreground">
          Example only: <code>{copy.example}</code>. Commands run only after they are saved.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-soft-foreground">
            <span>Timeout per command</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={WORKTREE_SETUP_MAX_TIMEOUT_SECONDS}
              step={1}
              data-slot={`${copy.slot}-timeout`}
              data-reports-dirty=""
              value={timeoutText}
              readOnly={!editable}
              disabled={save.isPending}
              onChange={(event) => setTimeoutText(event.target.value)}
              className={`${control} min-h-11 w-28 md:min-h-0`}
            />
            <span>seconds</span>
          </label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="min-h-11 self-start md:min-h-0"
            data-action={`${copy.slot}-save`}
            disabled={!editable || unchanged || invalid !== null || save.isPending}
            onClick={submit}
          >
            {copy.save}
          </Button>
        </div>
      </WorktreeCommandsStatus>
    </SettingsField>
  )
}
