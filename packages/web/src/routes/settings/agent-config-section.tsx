import { FileCogIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '@/api/client'
import { runnerIds, useRunners } from '@/api/runners'
import { queryKeys, useAgentConfig, useAgentConfigFile, useHealth, usePutAgentConfigFile } from '@/api/queries'
import type { AgentConfigFile, AgentConfigListing, HealthResponse, Runner } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { CodeEditor } from '@/components/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { availableRunners } from '@/routes/new-task-form'
import { cn } from '@/lib/utils'
import { useUnsentDraft } from '@/lib/version-reload'
import { agentDescriptors, type AgentDescriptor } from './agent-descriptors'
import { useQueryClient } from '@tanstack/react-query'
import { REMOTE_SETTINGS_ENABLE_COMMAND, RemoteSettingsNotice, useSettingsAdminRefresh } from './remote-settings-notice'

/**
 * Settings → Agent config (spec #404, regrouped per
 * 2026-07-17-agent-config-by-agent): read and edit the coding agents' OWN config
 * files — raw, per scope, highlighted — grouped BY AGENT. An agent selector
 * first; the selected agent's pane holds its Settings, MCP and Memory files
 * together, driven by the per-agent descriptor table. Squawk never re-serializes;
 * it shows each scope's file and the vendor's own documented precedence, and
 * never claims a merge it does not perform. Writing needs settings
 * administration: a local cockpit, or a remote one whose host operator ran
 * `cez remote-settings enable` (hearsay-tools/cezarion#2428). Otherwise the whole
 * section is read-only (the server refuses every write regardless).
 */

/** What this file actually governs for a run — the honest label the spec insists on. */
function effectLabel(file: AgentConfigFile): string {
  if (file.seeded) return 'Copied into each run’s worktree — takes effect on your next run.'
  if (file.tracked === 'tracked') return 'Runs read the committed copy — this edit applies after you commit it.'
  if (file.tracked === 'outside-repo') return 'Applies to every session on this machine.'
  return 'Personal, git-ignored.'
}

export function AgentConfigSection() {
  const listing = useAgentConfig()
  const refreshSettingsAdmin = useSettingsAdminRefresh()
  const health = useHealth()
  const runnersQuery = useRunners()
  const registered = runnersQuery.data
  const descriptors = useMemo(() => agentDescriptors(registered), [registered])
  const installed = useMemo<Runner[]>(
    () => (health.data ? availableRunners(health.data.checks, registered) : runnerIds(registered)),
    [health.data, registered],
  )

  // Errors first: a failed query must show its message, not the loading line.
  if (runnersQuery.isError) {
    return (
      <CenteredState
        icon={<FileCogIcon />}
        tone="danger"
        title="Runners did not load"
        subtitle={runnersQuery.error.message}
        heading="h2"
      />
    )
  }
  if (listing.isError) {
    return (
      <CenteredState
        icon={<FileCogIcon />}
        tone="danger"
        title="Agent config did not load"
        subtitle={listing.error.message}
        heading="h2"
      />
    )
  }
  if (listing.isPending || registered === undefined) {
    return (
      <p data-slot="agent-config-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent config…
      </p>
    )
  }
  return <AgentConfigView listing={listing.data} descriptors={descriptors} installed={installed} onOpenFile={refreshSettingsAdmin} />
}

function AgentConfigView({
  listing,
  descriptors,
  installed,
  onOpenFile,
}: {
  listing: AgentConfigListing
  descriptors: readonly AgentDescriptor[]
  installed: Runner[]
  /** Re-reads the host's edit grant: the first file opens on load, so a click no longer mounts the
   *  editor that used to re-read it. */
  onOpenFile: () => Promise<void>
}) {
  const [agentId, setAgentId] = useState<Runner>('claude')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // A saved or default agent id that no runner registered falls back to the first pane.
  const agent = descriptors.find((d) => d.id === agentId) ?? descriptors[0]
  if (agent === undefined) return null
  // With nothing picked yet, the agent's first file opens, so the editor column always shows a file
  // pane instead of a one-line hint over an empty column. A pick that left the agent's files falls
  // back the same way.
  const agentFiles = agentFileList(agent, listing)
  const selected = agentFiles.find((f) => f.id === selectedId) ?? agentFiles[0] ?? null

  const pickAgent = (id: Runner) => {
    setAgentId(id)
    setSelectedId(null)
  }

  return (
    <div data-slot="agent-config" className="flex flex-col gap-5 p-4 md:p-6">
      <p className="text-[13px] text-muted-foreground">Edit agent instructions and MCP configuration for this project.</p>
      {!listing.editable && (
        <div
          data-slot="agent-config-readonly"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-soft-foreground"
        >
          Read-only: this remote cockpit cannot edit agent config. You can still see every file and which one wins.
          To edit here, the host operator runs <code>{REMOTE_SETTINGS_ENABLE_COMMAND}</code>.
        </div>
      )}
      <RemoteSettingsNotice risk={`Agent config can define hooks and MCP servers that run commands on the machine running Squawk`} />

      <div data-slot="agent-config-agents" role="tablist" className="flex flex-wrap gap-1">
        {descriptors.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={d.id === agent.id}
            data-slot="agent-config-agent"
            data-agent={d.id}
            data-selected={d.id === agent.id}
            onClick={() => pickAgent(d.id)}
            className={cn(
              // Height comes from settings-interiors.css (44px at the mobile breakpoint, 40px on desktop);
              // the min width is what keeps a two-letter label like "Pi" a 44px-wide target.
              'flex min-w-11 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors',
              d.id === agent.id ? 'bg-background font-semibold shadow-sm' : 'hover:bg-muted/60',
            )}
          >
            {d.label}
            {!installed.includes(d.id) && (
              <Badge variant="outline" className="text-[12px] text-soft-foreground">
                not installed
              </Badge>
            )}
          </button>
        ))}
      </div>

      {agent.note && (
        <p data-slot="agent-config-agent-note" className="text-[12px] text-soft-foreground">
          {agent.note}
        </p>
      )}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(17rem,24rem)_minmax(0,1fr)]">
        <nav data-slot="agent-config-nav" className="flex min-w-0 flex-col gap-5">
          <AgentPane agent={agent} listing={listing} selectedId={selected?.id ?? null} onSelect={(id) => {
            setSelectedId(id)
            void onOpenFile()
          }} />
        </nav>
        <div data-slot="agent-config-editor-pane" className="min-w-0">
          {selected ? (
            <FileEditor key={selected.id} file={selected} />
          ) : (
            // Only an agent with no files at all gets here: a short note, not a full-height empty frame.
            <p data-slot="agent-config-editor-empty" className="rounded-md border border-border bg-muted/40 px-4 py-3 text-[13px] text-soft-foreground">
              This agent has no config files to show.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** The agent's files in pane order. A file two groups list appears twice; only the first counts. */
function agentFileList(agent: AgentDescriptor, listing: AgentConfigListing): AgentConfigFile[] {
  return agent.groups.flatMap((g) => listing.files.filter(g.files))
}

/** The home folder as `~`. The server sends Claude's state file as an absolute path, while the file
 *  labels already use `~/`: a user-scope file whose label starts with `~/` gives the home folder,
 *  so both read the same way even when the server's home is not under /home or /Users. */
function homeShortPath(path: string, files: readonly AgentConfigFile[]): string {
  for (const file of files) {
    if (!file.label.startsWith('~/')) continue
    const rest = file.label.slice(1)
    if (!file.path.endsWith(rest)) continue
    const home = file.path.slice(0, file.path.length - rest.length)
    if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  }
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
}

function AgentPane({
  agent,
  listing,
  selectedId,
  onSelect,
}: {
  agent: AgentDescriptor
  listing: AgentConfigListing
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <>
      {agent.groups.map((g) => {
        const files = listing.files.filter(g.files)
        const userMcp = g.showsUserMcp ? listing.userMcp : undefined
        // An empty group vanishes unless the descriptor gave it `empty` copy — a group that is
        // empty BY DESIGN (Pi's MCP: "No MCP.") says so and what to try, instead of hiding.
        if (files.length === 0 && !userMcp && !g.empty) return null
        return (
          <section key={g.id} data-slot="agent-config-group" data-group={g.id} data-agent={agent.id}>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-soft-foreground">
              {g.label}
            </p>
            {g.note && <p className="mb-2 text-[12px] text-soft-foreground">{g.note}</p>}
            {files.length === 0 && g.empty && (
              <p
                data-slot="agent-config-group-empty"
                className="rounded-md border border-dashed border-border px-3 py-2 text-[12px] text-soft-foreground"
              >
                {g.empty}
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    data-slot="agent-config-file"
                    data-selected={file.id === selectedId}
                    onClick={() => onSelect(file.id)}
                    title={file.label}
                    className={cn(
                      'flex w-full flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                      file.id === selectedId ? 'bg-accent-strong/15 text-foreground' : 'hover:bg-muted/60',
                    )}
                  >
                    {/* The full filename on its own line — it wraps, never truncates — and the
                        status badges on a compact subline below it. */}
                    <span data-slot="agent-config-file-name" className="min-w-0 max-w-full break-all font-mono text-[12px]">{file.label}</span>
                    {file.seeded || !file.exists ? (
                      <span data-slot="agent-config-file-meta" className="flex flex-wrap items-center gap-1.5">
                        {file.seeded && (
                          <Badge variant="outline" className="text-[11px]">
                            Default template
                          </Badge>
                        )}
                        {!file.exists && <span className="text-[11px] text-muted-foreground">Not created</span>}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            {userMcp && <UserMcpBlock userMcp={userMcp} path={homeShortPath(userMcp.path, listing.files)} />}
          </section>
        )
      })}
    </>
  )
}

/** Claude's user/local MCP scopes live in ~/.claude.json (Claude's own state
 *  file) — listed read-only; Squawk never edits it. */
function UserMcpBlock({ userMcp, path }: { userMcp: NonNullable<AgentConfigListing['userMcp']>; path: string }) {
  return (
    <div data-slot="agent-config-user-mcp" className="mt-3">
      <h4 className="mb-1 text-[12px] font-semibold">User &amp; local scopes</h4>
      <p className="mb-2 text-[12px] text-soft-foreground">
        {/* One unbroken code span: a wrap inside the command split it into a code half and a prose half. */}
        Managed by <code data-slot="agent-config-user-mcp-command" className="whitespace-nowrap font-mono">claude mcp add</code> in{' '}
        <code data-slot="agent-config-user-mcp-path" title={userMcp.path} className="break-all font-mono">{path}</code> — Squawk
        does not edit Claude’s state file.
      </p>
      {userMcp.readable ? (
        userMcp.servers.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {userMcp.servers.map((name) => (
              <li key={name}>
                <Badge variant="outline" className="font-mono text-[11px]">
                  {name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-soft-foreground">No user-scoped MCP servers.</p>
        )
      ) : (
        <p className="text-[12px] text-soft-foreground">Could not read the file.</p>
      )}
    </div>
  )
}

export function FileEditor({ file }: { file: AgentConfigFile }) {
  const fileQuery = useAgentConfigFile(file.id)
  const [draft, setDraft] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [formatError, setFormatError] = useState<string | null>(null)

  const loadedVersion = fileQuery.data?.version ?? null
  const content = draft ?? fileQuery.data?.content ?? ''
  const dirty = fileQuery.data ? content !== fileQuery.data.content : false
  const canWrite = file.writable
  const isMcp = file.kind === 'mcp' || file.holdsMcp
  useUnsentDraft(canWrite && dirty)

  const { save, isSaving } = useFileSave({
    file,
    content,
    loadedVersion,
    setDraft,
    setConflict,
    setFormatError,
  })

  // Seed the draft from the server contents; re-seed when the file's version changes underneath.
  useEffect(() => {
    if (fileQuery.data) {
      setDraft(fileQuery.data.content)
      setConflict(false)
      setFormatError(null)
    }
  }, [fileQuery.data?.version, fileQuery.data])

  return (
    <div data-slot="settings-config-editor" data-reports-dirty="" className="flex flex-col gap-3">
      <h3 className="text-sm">Configuration file</h3>
      <p data-slot="agent-config-scope" title={file.path} className="text-[12px] text-muted-foreground break-words">{file.scope.charAt(0).toUpperCase() + file.scope.slice(1)} scope · {homeShortPath(file.path, [file])}</p>
      <div className="settings-readout flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">{file.label}</span>
        <Badge variant="outline" className="text-[12px] uppercase">
          {file.format}
        </Badge>
        <a
          href={file.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[12px] text-soft-foreground underline hover:text-foreground"
        >
          docs
        </a>
      </div>

      <div className="settings-config-content-heading">
        <h3>{isMcp ? 'MCP configuration' : 'File contents'}</h3>
        {isMcp && <p>Review server commands before saving. MCP servers execute locally.</p>}
      </div>

      {fileQuery.isPending ? (
        <p className="text-[13px] text-soft-foreground">Loading file…</p>
      ) : fileQuery.isError ? (
        <p className="text-[13px] text-destructive">{fileQuery.error.message}</p>
      ) : (
        <EditorFrame file={file} content={content} isMcp={isMcp} onChange={setDraft} />
      )}

      <SaveStateMessages formatError={formatError} conflict={conflict} onReload={() => void fileQuery.refetch()} />

      {canWrite && (
        <FileActions exists={file.exists} dirty={dirty} isSaving={isSaving} onSave={save} onReset={() => setDraft(null)} />
      )}
      <div className="settings-config-save-help">
      <p data-slot="agent-config-precedence" className="text-[12px] text-soft-foreground">
        {file.precedence}
      </p>
      <p data-slot="agent-config-effect" className="text-[12px] text-foreground/80">
        {effectLabel(file)}
        {file.hotReload ? ` ${file.hotReload}` : ''}
      </p>

        <ReadOnlyReason reason={file.readOnlyReason} />
      </div>
    </div>
  )
}

/** The editor, with a faint example over it while a file that does not exist yet is still empty. */
function EditorFrame({
  file,
  content,
  isMcp,
  onChange,
}: {
  file: AgentConfigFile
  content: string
  isMcp: boolean
  onChange: (next: string) => void
}) {
  return (
    <div data-slot="agent-config-editor-frame" className="relative">
      <CodeEditor
        value={content}
        language={file.format}
        readOnly={!file.writable}
        onChange={onChange}
        aria-label={`${file.label} contents`}
        className="h-[210px]"
      />
      {/* The editor has no placeholder, so this overlay sits on its surface, inset by its 1px
          border and with its padding and font, and vanishes on the first keystroke. */}
      {!file.exists && content === '' && (
        <pre
          data-slot="agent-config-placeholder"
          aria-hidden="true"
          className="pointer-events-none absolute inset-px m-0 overflow-hidden whitespace-pre px-3 py-2 font-mono text-xs leading-[1.7] text-muted-foreground/80"
        >
          {placeholderFor(file, isMcp)}
        </pre>
      )}
    </div>
  )
}

/** Save/Create and Reset, with a quiet cue that says why they are disabled — the same voice as
 *  "No unsaved changes" on every other settings page. */
function FileActions({
  exists,
  dirty,
  isSaving,
  onSave,
  onReset,
}: {
  exists: boolean
  dirty: boolean
  isSaving: boolean
  onSave: () => void
  onReset: () => void
}) {
  const cue = dirty ? 'Unsaved changes' : exists ? 'No unsaved changes' : 'Enter content above to create this file'
  return (
    <div className="settings-form-actions">
      <Button size="sm" onClick={onSave} disabled={!dirty || isSaving}>
        {exists ? 'Save file' : 'Create file'}
      </Button>
      <Button size="sm" variant="outline" onClick={onReset} disabled={!dirty || isSaving}>
        Reset
      </Button>
      {!isSaving && (
        <span data-slot="agent-config-save-cue" className="self-center text-xs text-muted-foreground">
          {cue}
        </span>
      )}
    </div>
  )
}

/** An example for a file that does not exist yet, in the file's own format. Its first line says the
 *  file is not created yet, so the faint text never reads as contents already on disk. */
function placeholderFor(file: AgentConfigFile, isMcp: boolean): string {
  switch (file.format) {
    case 'json':
    case 'jsonc':
      return `// File not created yet — example:\n${isMcp ? '{\n  "mcpServers": {}\n}' : '{\n  "permissions": {}\n}'}`
    case 'markdown':
      return '<!-- File not created yet — write instructions here -->'
    case 'toml':
      return '# File not created yet — example:\n# key = "value"'
    case 'yaml':
      return '# File not created yet — example:\n# key: value'
  }
}

function SaveStateMessages({
  formatError,
  conflict,
  onReload,
}: {
  formatError: string | null
  conflict: boolean
  onReload: () => void
}) {
  return (
    <>
      {formatError && (
        <p data-slot="agent-config-format-error" className="text-[12px] text-destructive">
          {formatError}
        </p>
      )}
      {conflict && (
        <div
          data-slot="agent-config-conflict"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]"
        >
          <span>The file changed on disk since you opened it.</span>
          <Button size="sm" variant="outline" onClick={onReload}>
            Reload from disk
          </Button>
        </div>
      )}
    </>
  )
}

function ReadOnlyReason({ reason }: { reason: AgentConfigFile['readOnlyReason'] }) {
  return reason && <p>{reason}</p>
}

function useFileSave({
  file,
  content,
  loadedVersion,
  setDraft,
  setConflict,
  setFormatError,
}: {
  file: AgentConfigFile
  content: string
  loadedVersion: string | null
  setDraft: (draft: string | null) => void
  setConflict: (conflict: boolean) => void
  setFormatError: (error: string | null) => void
}) {
  const put = usePutAgentConfigFile(file.id)
  const queryClient = useQueryClient()
  const refreshSettingsAdmin = useSettingsAdminRefresh()

  const save = () => {
    setFormatError(null)
    setConflict(false)
    put.mutate(
      { content, version: loadedVersion },
      {
        onSuccess: () => {
          setDraft(null)
          toast(`${file.exists ? 'Saved' : 'Created'} ${file.label}`)
        },
        onError: (err) => {
          // A 409 is a version conflict, or the host withdrew the grant since the page loaded.
          if (err instanceof ApiError && err.status === 409) {
            void refreshSettingsAdmin().then(() => {
              const health = queryClient.getQueryData<HealthResponse>(queryKeys.health)
              if (health?.capabilities.settingsAdmin === false) toast(err.message, { tone: 'danger' })
              else setConflict(true)
            })
          } else if (err instanceof ApiError && err.status === 400) setFormatError(err.message)
          else toast((err as Error).message, { tone: 'danger' })
        },
      },
    )
  }

  return { save, isSaving: put.isPending }
}
