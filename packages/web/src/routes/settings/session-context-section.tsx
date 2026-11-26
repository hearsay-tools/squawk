import { FileStackIcon, PlusIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

import { ApiError } from '@/api/client'
import { usePutSessionContext, useSessionContext, useSessionContextPreview } from '@/api/queries'
import type {
  SessionContextFile,
  SessionContextProblem,
  SessionContextRole,
  SessionContextSharedFile,
  SessionContextState,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { CodeEditor } from '@/components/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { useUnsentDraft } from '@/lib/version-reload'
import { SessionContextPreviewPanel } from './session-context-preview'
import { valueForKey } from './session-context-keys'
import { FILE_TOKEN_LABEL, SESSION_CONTEXT_TOKENS, addRule, insertToken, lineRange } from './session-context-draft'

const DOCS_URL = 'https://github.com/hearsay-tools/squawk/blob/main/docs/context-injection.md'

/**
 * Settings → Session context (hearsay-tools/squawk#4308, hearsay-tools/squawk#4341): edits host-local gitignored
 * `context.local.yaml` by default, shows repo-tracked `context.yaml` read-only with tracked status,
 * and previews the combined launch output (handoff, shared, then local).
 */
export function SessionContextSection() {
  const query = useSessionContext()
  return (
    <div data-slot="session-context" className="flex flex-col gap-4 p-4 md:p-6">
      <HandoffCard />
      {query.data !== undefined ? (
        // A failed reload keeps the last good state, so the editor and its draft stay mounted.
        <>
          {query.isError && (
            <p data-slot="session-context-reload-error" role="alert" className="text-[13px] text-danger">
              Could not read session context again: {query.error.message}
            </p>
          )}
          <SessionContextWorkspace
            key={query.data.local.path}
            state={query.data}
            refetch={() => query.refetch()}
          />
        </>
      ) : query.isError ? (
        <CenteredState
          icon={<FileStackIcon />}
          tone="danger"
          title="Session context did not load"
          subtitle={query.error.message}
          heading="h2"
          actions={<Button variant="outline" onClick={() => void query.refetch()}>Try again</Button>}
        />
      ) : (
        <LoadingShape />
      )}
    </div>
  )
}

function HandoffCard() {
  return (
    <div data-slot="session-context-handoff" className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Handoff block</h3>
          <Badge variant="outline" className="border-accent-strong/40 text-[11px] text-link-foreground">Built in · always first</Badge>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Each task’s own handoff file: Goal, Progress log and Resume notes. It needs no setup and cannot be turned off. Shared and local rules come after it.
        </p>
      </div>
    </div>
  )
}

/** The editor and preview's shape while the files load, so the page does not jump. */
function LoadingShape() {
  return (
    <div data-slot="session-context-loading" aria-busy="true" aria-label="Loading session context" className="grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <Skeleton className="h-[420px] rounded-lg" />
      <Skeleton className="h-[420px] rounded-lg max-md:hidden" />
    </div>
  )
}

/** The draft as it stood once typing paused, so the preview asks once per pause, not per key. */
function useSettled(value: string, delayMs = 250): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

type SaveFailure = { kind: 'conflict'; message: string } | { kind: 'error'; message: string }
type Pane = 'edit' | 'preview'
type Scope = 'local' | 'shared'

/** The local draft, its combined server preview, and the save that never loses the draft. */
function useSessionContextDraft(file: SessionContextFile, shared: SessionContextSharedFile, refetch: () => Promise<unknown>) {
  const [draft, setDraftText] = useState<string | null>(null)
  // The version the draft started from. A background reload may bring a newer file; a normal save
  // still names this one, so it gets a conflict instead of overwriting the other edit.
  const [base, setBase] = useState<{ version: string | null } | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const setDraft = (text: string) => {
    setBase((pinned) => pinned ?? { version: file.version })
    setDraftText(text)
  }
  const [role, setRole] = useState<SessionContextRole>('parent')
  const [pane, setPane] = useState<Pane>('edit')
  const [scope, setScope] = useState<Scope>('local')
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [showDisk, setShowDisk] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [selection, setSelection] = useState<[number, number] | null>(null)

  const content = draft ?? file.content
  const dirty = content !== file.content
  // A draft counts as unsent even when the file has turned read only under it.
  useUnsentDraft(dirty)

  const settled = useSettled(content)
  const sharedKey = `${shared.path}|${shared.exists ? '1' : '0'}|${shared.unreadableReason ?? ''}|${shared.content}`
  const preview = useSessionContextPreview(settled, role, sharedKey)
  // A cached good answer does not count once checking the same draft again has failed.
  const current = preview.data !== undefined && !preview.isPlaceholderData && !preview.isError && settled === content
  const previewError = preview.isError && !preview.isFetching && settled === content ? preview.error.message : null
  const problems = useMemo(() => preview.data?.problems ?? [], [preview.data])
  const put = usePutSessionContext()

  // Apply a selection after the text it points into has rendered.
  useLayoutEffect(() => {
    if (!selection || !inputRef.current) return
    inputRef.current.focus()
    inputRef.current.setSelectionRange(selection[0], selection[1])
    setSelection(null)
  }, [selection])

  const edit = (next: { text: string; select: [number, number] }) => {
    setDraft(next.text)
    setScope('local')
    setPane('edit')
    setSelection(next.select)
  }
  const insert = (token: string) => {
    const input = inputRef.current
    edit(insertToken(content, input?.selectionStart ?? content.length, input?.selectionEnd ?? content.length, token))
  }
  const goToLine = (line: number) => {
    setScope('local')
    setPane('edit')
    setSelection(lineRange(content, line))
  }
  const discard = () => {
    setDraftText(null)
    setBase(null)
    setFailure(null)
  }
  /** `overwrite` saves over the version on disk now; a normal save names the draft's base. */
  const save = (overwrite = false) => {
    const version = overwrite || base === null ? file.version : base.version
    setFailure(null)
    const sent = content
    put.mutate(
      { content: sent, version },
      {
        onSuccess: (saved) => {
          // Text typed while the save was on its way stays as the draft, now based on the saved file.
          const kept = draftRef.current !== null && draftRef.current !== sent
          setDraftText(kept ? draftRef.current : null)
          setBase(kept ? { version: saved.local.version } : null)
          setShowDisk(false)
          toast(`Saved ${saved.local.path}`)
        },
        onError: (error) => {
          const conflict = error instanceof ApiError && error.status === 409
          setFailure({ kind: conflict ? 'conflict' : 'error', message: error.message })
          if (conflict) void refetch()
        },
      },
    )
  }

  return {
    localStarted: file.exists || draft !== null, content, dirty, setDraft, role, setRole, pane, setPane,
    scope, setScope, failure, showDisk, toggleDisk: () => setShowDisk((shown) => !shown), inputRef,
    preview: preview.data, current, problems, previewError, retryPreview: () => void preview.refetch(),
    saving: put.isPending, edit, insert, goToLine, discard, save,
  }
}

function SessionContextWorkspace({ state, refetch }: { state: SessionContextState; refetch: () => Promise<unknown> }) {
  const { local, shared } = state
  const editor = useSessionContextDraft(local, shared, refetch)
  const { content, problems, current } = editor
  const writable = local.writable
  const marked = useMemo(() => new Set(problems.flatMap((p) => (p.line === null ? [] : [p.line]))), [problems])

  if (!editor.localStarted && !shared.exists) {
    return (
      <EmptyRules
        localPath={local.path}
        sharedPath={shared.path}
        readOnlyReason={local.readOnlyReason}
        onAdd={writable ? () => editor.edit(addRule('', shared.content)) : undefined}
      />
    )
  }
  return (
    <div data-slot="session-context-editor" data-reports-dirty="" className="flex flex-col gap-4">
      {!writable && editor.scope === 'local' && <ReadOnlyNotice reason={local.readOnlyReason} />}
      {editor.failure && writable && (
        <SaveFailureNotice failure={editor.failure} showDisk={editor.showDisk} onShowDisk={editor.toggleDisk} onOverwrite={() => editor.save(true)} />
      )}
      {editor.showDisk && <DiskVersion content={local.content} />}
      {editor.previewError && (
        <div data-slot="session-context-preview-error" role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/45 bg-danger/10 p-3 text-[13px]">
          <span className="mr-auto">The preview failed: {editor.previewError}. Save stays off until the draft is checked.</span>
          <Button variant="outline" onClick={editor.retryPreview}>Check again</Button>
        </div>
      )}
      {problems.length > 0 && <ProblemList problems={problems} onLine={editor.goToLine} />}
      <PaneTabs pane={editor.pane} onPane={editor.setPane} />
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section
          id={PANE_IDS.edit}
          data-slot="session-context-file"
          aria-label="Session context rules"
          className={cn('flex flex-col overflow-hidden rounded-lg border border-border bg-card', editor.pane !== 'edit' && 'max-md:hidden')}
        >
          <ScopeTabs scope={editor.scope} onScope={editor.setScope} dirty={editor.dirty} shared={shared} />
          {editor.scope === 'local' ? (
            <LocalLayerPanel
              file={local}
              sharedPath={shared.path}
              started={editor.localStarted}
              content={content}
              dirty={editor.dirty}
              problems={problems.length}
              current={current}
              previewFailed={editor.previewError !== null}
              marked={marked}
              inputRef={editor.inputRef}
              onDraft={editor.setDraft}
              onAdd={() => editor.edit(addRule(content, shared.content))}
              onInsert={editor.insert}
            />
          ) : (
            <SharedLayerPanel shared={shared} onOpenLocal={() => editor.setScope('local')} />
          )}
        </section>
        <SessionContextPreviewPanel
          id={PANE_IDS.preview}
          preview={editor.preview}
          role={editor.role}
          onRole={editor.setRole}
          pending={!current}
          className={cn(editor.pane !== 'preview' && 'max-md:hidden')}
        />
      </div>
      {(editor.localStarted || editor.dirty) && (
        <SaveBar
          localPath={local.path}
          writable={writable}
          hasProblems={problems.length > 0}
          dirty={editor.dirty}
          saving={editor.saving}
          canSave={writable && editor.dirty && !editor.saving && current && problems.length === 0}
          onDiscard={editor.discard}
          onSave={() => editor.save()}
        />
      )}
    </div>
  )
}

const SCOPES = ['local', 'shared'] as const
const SCOPE_PANEL_IDS: Record<Scope, string> = { local: 'session-context-local-panel', shared: 'session-context-shared-panel' }

function ScopeTabs({
  scope,
  onScope,
  dirty,
  shared,
}: {
  scope: Scope
  onScope: (scope: Scope) => void
  dirty: boolean
  shared: SessionContextSharedFile
}) {
  const tabs = useRef(new Map<Scope, HTMLButtonElement>())
  const onKeyDown = (event: KeyboardEvent) => {
    const next = valueForKey(SCOPES, scope, event.key)
    if (next === undefined) return
    event.preventDefault()
    onScope(next)
    tabs.current.get(next)?.focus()
  }
  return (
    <div role="tablist" aria-label="Context rule layer" onKeyDown={onKeyDown} className="flex border-b border-border bg-muted/30">
      {SCOPES.map((value) => {
        const selected = scope === value
        return (
          <button
            key={value}
            ref={(element) => {
              if (element) tabs.current.set(value, element)
              else tabs.current.delete(value)
            }}
            type="button"
            role="tab"
            tabIndex={selected ? 0 : -1}
            aria-selected={selected}
            aria-controls={SCOPE_PANEL_IDS[value]}
            data-slot="session-context-scope"
            data-scope={value}
            onClick={() => onScope(value)}
            className={cn(
              'flex min-h-11 flex-1 items-center justify-center gap-2 border-b-2 border-transparent px-3 text-[13px] font-medium text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring',
              selected && 'border-accent-strong bg-card text-foreground',
            )}
          >
            <span>{value === 'local' ? 'Local' : 'Shared'}</span>
            {value === 'local' && dirty && <span className="text-[11px] text-conflict">· Unsaved</span>}
            {value === 'shared' && shared.tracked && <span className="text-[11px] text-soft-foreground">· Tracked</span>}
          </button>
        )
      })}
    </div>
  )
}

function LocalLayerPanel(props: {
  file: SessionContextFile
  sharedPath: string
  started: boolean
  content: string
  dirty: boolean
  problems: number
  current: boolean
  previewFailed: boolean
  marked: ReadonlySet<number>
  inputRef: RefObject<HTMLTextAreaElement | null>
  onDraft: (text: string) => void
  onAdd: () => void
  onInsert: (token: string) => void
}) {
  const { file, started, content } = props
  const writable = file.writable
  return (
    <div id={SCOPE_PANEL_IDS.local} role="tabpanel" className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <code className="font-mono text-[12px] break-all">{file.path}</code>
        <Badge variant="outline" className="text-[11px]">Gitignored · local</Badge>
        {started && <FileStatus problems={props.problems} current={props.current} failed={props.previewFailed} dirty={props.dirty} />}
        {writable && started && (
          <Button data-slot="session-context-add-rule" variant="outline" className="ml-auto min-h-11" onClick={props.onAdd}>
            <PlusIcon /> Add rule
          </Button>
        )}
      </div>
      {!started ? (
        <div data-slot="session-context-local-empty" className="flex flex-col items-start gap-3 p-4">
          <p className="text-[13px] text-muted-foreground">
            No local rules yet. Local rules live in <code className="font-mono text-[12px] text-foreground">{file.path}</code> (auto-ignored by Git) and run after shared rules from <code className="font-mono text-[12px] text-foreground">{props.sharedPath}</code>. Reuse a shared rule’s <code className="font-mono text-[12px] text-foreground">id</code> to replace it locally, or set <code className="font-mono text-[12px] text-foreground">enabled: false</code> to mute it.
          </p>
          {writable && (
            <Button data-slot="session-context-add-rule" className="min-h-11" onClick={props.onAdd}>
              <PlusIcon /> Add a local rule
            </Button>
          )}
        </div>
      ) : (
        <>
          <CodeEditor
            value={content}
            onChange={writable ? props.onDraft : undefined}
            readOnly={!writable}
            language="yaml"
            markedLines={props.marked}
            inputRef={props.inputRef}
            aria-label="context.local.yaml rules"
            className="h-[420px] rounded-none border-0"
          />
          {writable && <TokenChips onInsert={props.onInsert} />}
        </>
      )}
    </div>
  )
}

function SharedTrackedBadge({ shared }: { shared: SessionContextSharedFile }) {
  if (!shared.exists) return <Badge data-slot="session-context-shared-status" variant="outline" className="text-[11px]">Not in repo</Badge>
  if (shared.tracked) {
    return (
      <Badge data-slot="session-context-shared-status" variant="outline" className="border-accent-strong/40 text-[11px] text-link-foreground">
        Tracked in Git
      </Badge>
    )
  }
  return <Badge data-slot="session-context-shared-status" variant="outline" className="text-[11px]">Untracked · repo file</Badge>
}

function SharedLayerPanel({ shared, onOpenLocal }: { shared: SessionContextSharedFile; onOpenLocal: () => void }) {
  return (
    <div id={SCOPE_PANEL_IDS.shared} role="tabpanel" data-slot="session-context-shared" className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <code className="font-mono text-[12px] break-all">{shared.path}</code>
        <SharedTrackedBadge shared={shared} />
        <Badge variant="outline" className="text-[11px]">Read only</Badge>
      </div>
      <p data-slot="session-context-shared-note" className="border-b border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
        Shared team rules are versioned in Git and read only here. To replace or mute a rule on this host without dirtying Git, add a rule with the same id in Local.
      </p>
      {shared.unreadableReason ? (
        <div className="p-3"><ReadOnlyNotice reason={shared.unreadableReason} /></div>
      ) : !shared.exists ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <p className="text-[13px] text-muted-foreground">
            This repository has no shared <code className="font-mono text-[12px] text-foreground">{shared.path}</code> yet. Commit one to share team rules across contributors, or add host-only rules in Local.
          </p>
          <Button variant="outline" className="min-h-11" onClick={onOpenLocal}>Edit Local rules</Button>
        </div>
      ) : (
        <CodeEditor
          value={shared.content}
          language="yaml"
          readOnly
          aria-label="context.yaml shared rules"
          className="h-[420px] rounded-none border-0"
        />
      )}
    </div>
  )
}

const PANES = ['edit', 'preview'] as const
const PANE_IDS: Record<Pane, string> = { edit: 'session-context-edit-panel', preview: 'session-context-preview-panel' }

/** A tab list: one tab stop on the selected tab, arrow keys move and select (phones only). */
function PaneTabs({ pane, onPane }: { pane: Pane; onPane: (pane: Pane) => void }) {
  const tabs = useRef(new Map<Pane, HTMLButtonElement>())
  const onKeyDown = (event: KeyboardEvent) => {
    const next = valueForKey(PANES, pane, event.key)
    if (next === undefined) return
    event.preventDefault()
    onPane(next)
    tabs.current.get(next)?.focus()
  }
  return (
    <div role="tablist" aria-label="Session context view" onKeyDown={onKeyDown} className="flex overflow-hidden rounded-md border border-[var(--control-border)] md:hidden">
      {PANES.map((value) => (
        <button
          key={value}
          ref={(element) => {
            if (element) tabs.current.set(value, element)
            else tabs.current.delete(value)
          }}
          type="button"
          tabIndex={pane === value ? 0 : -1}
          aria-controls={PANE_IDS[value]}
          role="tab"
          data-slot="session-context-pane"
          data-pane={value}
          aria-selected={pane === value}
          onClick={() => onPane(value)}
          className={cn('min-h-11 flex-1 text-[13px] capitalize text-muted-foreground', pane === value && 'bg-muted text-foreground')}
        >
          {value}
        </button>
      ))}
    </div>
  )
}

function DiskVersion({ content }: { content: string }) {
  return (
    <div data-slot="session-context-disk" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">On disk now</h3>
      <CodeEditor value={content} language="yaml" readOnly aria-label="context.local.yaml on disk" className="h-[200px]" />
    </div>
  )
}

function SaveBar(props: {
  localPath: string
  writable: boolean
  hasProblems: boolean
  dirty: boolean
  saving: boolean
  canSave: boolean
  onDiscard: () => void
  onSave: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <p data-slot="session-context-note" className="mr-auto text-[12px] text-soft-foreground">
        {props.hasProblems
          ? 'Save is off while the file has problems.'
          : `Applies from the next session launch. Saved to ${props.localPath} (gitignored; does not dirty Git).`}
      </p>
      {props.writable && (
        <>
          <Button variant="outline" className="min-h-11" disabled={!props.dirty || props.saving} onClick={props.onDiscard}>Discard changes</Button>
          <Button data-slot="session-context-save" className="min-h-11" disabled={!props.canSave} onClick={props.onSave}>{props.saving ? 'Saving…' : 'Save'}</Button>
        </>
      )}
    </div>
  )
}

function FileStatus({ problems, current, failed, dirty }: { problems: number; current: boolean; failed: boolean; dirty: boolean }) {
  return (
    <span className="flex flex-wrap gap-1.5" aria-live="polite">
      {current && problems > 0 && (
        <Badge variant="outline" className="border-danger/45 text-[11px] text-danger">
          {problems} {problems === 1 ? 'problem' : 'problems'}
        </Badge>
      )}
      {current && problems === 0 && <Badge variant="outline" className="border-success/40 text-[11px] text-success">Valid</Badge>}
      {!current && !failed && <Badge variant="outline" className="text-[11px]">Checking…</Badge>}
      {failed && <Badge variant="outline" className="border-danger/45 text-[11px] text-danger">Not checked</Badge>}
      {dirty && <Badge variant="outline" className="border-conflict/50 text-[11px] text-conflict">Unsaved</Badge>}
    </span>
  )
}

function ProblemList({ problems, onLine }: { problems: SessionContextProblem[]; onLine: (line: number) => void }) {
  return (
    <div data-slot="session-context-problems" role="alert" className="rounded-lg border border-danger/45 bg-danger/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-danger">
          {problems.length} {problems.length === 1 ? 'problem' : 'problems'}: fix {problems.length === 1 ? 'it' : 'them'} to save
        </h3>
        <span className="ml-auto text-[12px] text-soft-foreground">Your draft is kept until you save or discard it.</span>
      </div>
      <ul className="mt-1.5 flex flex-col">
        {problems.map((problem, index) => (
          <li key={index} className="text-[13px] leading-6">
            {problem.line !== null && (
              <button
                type="button"
                data-slot="session-context-line"
                onClick={() => onLine(problem.line!)}
                className="inline-flex min-h-11 items-center align-middle text-link-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-8"
              >
                Line {problem.line}
              </button>
            )}
            {problem.line !== null && <span aria-hidden="true" className="text-soft-foreground"> · </span>}
            {problem.rule !== null && <span className="text-muted-foreground">rule {problem.rule}: </span>}
            <span data-slot="session-context-problem">{problem.message}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TokenChips({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div data-slot="session-context-tokens" className="flex flex-col gap-2 border-t border-border p-3">
      <span id="session-context-tokens" className="text-[12px] text-soft-foreground">Insert a variable</span>
      <div role="group" aria-labelledby="session-context-tokens" className="flex flex-wrap gap-1.5">
        {SESSION_CONTEXT_TOKENS.map((token) => (
          <button
            key={token}
            type="button"
            onClick={() => onInsert(token)}
            className="min-h-8 rounded-md bg-muted px-2 font-mono text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
          >
            {`{{${token.startsWith('file:') ? FILE_TOKEN_LABEL : token}}}`}
          </button>
        ))}
      </div>
    </div>
  )
}

function SaveFailureNotice({
  failure,
  showDisk,
  onShowDisk,
  onOverwrite,
}: {
  failure: SaveFailure
  showDisk: boolean
  onShowDisk: () => void
  onOverwrite: () => void
}) {
  return (
    <div data-slot="session-context-save-failure" role="alert" className="rounded-lg border border-danger/45 bg-danger/10 p-3">
      <h3 className="text-sm font-semibold text-danger">
        {failure.kind === 'conflict' ? 'Not saved: the file changed on disk' : 'Not saved'}
      </h3>
      <p className="mt-1 text-[13px] text-muted-foreground">{failure.message} Your draft is still here.</p>
      {failure.kind === 'conflict' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" onClick={onShowDisk}>{showDisk ? 'Hide the disk version' : 'Show the disk version'}</Button>
          <Button variant="outline" className="min-h-11" onClick={onOverwrite}>Overwrite it</Button>
        </div>
      )}
    </div>
  )
}

function ReadOnlyNotice({ reason }: { reason: string | null }) {
  return (
    <div data-slot="session-context-readonly" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
      Read only. {reason}
    </div>
  )
}

function EmptyRules({
  localPath,
  sharedPath,
  readOnlyReason,
  onAdd,
}: {
  localPath: string
  sharedPath: string
  readOnlyReason: string | null
  onAdd: (() => void) | undefined
}) {
  return (
    <div data-slot="session-context-empty" className="rounded-lg border border-border bg-card">
      <CenteredState
        icon={<FileStackIcon />}
        title="No project rules yet"
        heading="h2"
        subtitle={`Every session already starts with its handoff block. Commit shared team rules in ${sharedPath}, or add host-local rules in ${localPath} (gitignored; overrides shared rules with the same id).`}
        actions={
          <>
            {onAdd && <Button className="min-h-11" onClick={onAdd}>Add a local rule</Button>}
            <Button variant="outline" className="min-h-11" asChild>
              <a href={DOCS_URL} target="_blank" rel="noreferrer">How rules work</a>
            </Button>
          </>
        }
      >
        {readOnlyReason && <p className="text-[13px] text-muted-foreground">Read only. {readOnlyReason}</p>}
      </CenteredState>
    </div>
  )
}
