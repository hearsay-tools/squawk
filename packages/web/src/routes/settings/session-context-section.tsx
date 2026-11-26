import { FileStackIcon, PlusIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ApiError } from '@/api/client'
import { usePutSessionContext, useSessionContext, useSessionContextPreview } from '@/api/queries'
import type { SessionContextFile, SessionContextProblem, SessionContextRole } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { CodeEditor } from '@/components/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { useUnsentDraft } from '@/lib/version-reload'
import { SessionContextPreviewPanel } from './session-context-preview'
import { FILE_TOKEN_LABEL, SESSION_CONTEXT_TOKENS, addRule, insertToken, lineRange } from './session-context-draft'

const DOCS_URL = 'https://github.com/hearsay-tools/squawk/blob/main/docs/context-injection.md'

/**
 * Settings → Session context (hearsay-tools/squawk#4308): the project's `context.yaml` rules,
 * which every launched session gets after its built-in handoff block. The user edits the raw
 * YAML; the server parses and renders each draft, so the problems and the preview are the ones
 * a launch would see. Saving needs no settings administration: the file runs no host command.
 */
export function SessionContextSection() {
  const file = useSessionContext()
  return (
    <div data-slot="session-context" className="flex flex-col gap-4 p-4 md:p-6">
      <HandoffCard />
      {file.isError ? (
        <CenteredState
          icon={<FileStackIcon />}
          tone="danger"
          title="Session context did not load"
          subtitle={file.error.message}
          heading="h2"
          actions={<Button variant="outline" onClick={() => void file.refetch()}>Try again</Button>}
        />
      ) : file.data === undefined ? (
        <LoadingShape />
      ) : (
        <SessionContextEditor key={file.data.path} file={file.data} refetch={() => file.refetch()} />
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
          Each task’s own handoff file: Goal, Progress log and Resume notes. It needs no setup and cannot be turned off. Your rules come after it.
        </p>
      </div>
    </div>
  )
}

/** The editor and preview's shape while the file loads, so the page does not jump. */
function LoadingShape() {
  return (
    <div data-slot="session-context-loading" aria-busy="true" aria-label="Loading session context" className="grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <Skeleton className="h-[420px] rounded-lg motion-reduce:animate-none" />
      <Skeleton className="h-[420px] rounded-lg motion-reduce:animate-none max-md:hidden" />
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

/** The draft, its server-rendered preview, and the save that never loses the draft. */
function useSessionContextDraft(file: SessionContextFile, refetch: () => Promise<unknown>) {
  const [draft, setDraft] = useState<string | null>(null)
  const [role, setRole] = useState<SessionContextRole>('parent')
  const [pane, setPane] = useState<Pane>('edit')
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [showDisk, setShowDisk] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [selection, setSelection] = useState<[number, number] | null>(null)

  const content = draft ?? file.content
  const dirty = content !== file.content
  useUnsentDraft(file.writable && dirty)

  const settled = useSettled(content)
  const preview = useSessionContextPreview(settled, role)
  const current = preview.data !== undefined && !preview.isPlaceholderData && settled === content
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
    setPane('edit')
    setSelection(next.select)
  }
  const insert = (token: string) => {
    const input = inputRef.current
    edit(insertToken(content, input?.selectionStart ?? content.length, input?.selectionEnd ?? content.length, token))
  }
  const goToLine = (line: number) => {
    setPane('edit')
    setSelection(lineRange(content, line))
  }
  const discard = () => {
    setDraft(null)
    setFailure(null)
  }
  const save = (version: string | null) => {
    setFailure(null)
    put.mutate(
      { content, version },
      {
        onSuccess: () => {
          setDraft(null)
          setShowDisk(false)
          toast(`Saved ${file.path}`)
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
    started: file.exists || draft !== null, content, dirty, setDraft, role, setRole, pane, setPane, failure, showDisk,
    toggleDisk: () => setShowDisk((shown) => !shown), inputRef, preview: preview.data, current, problems,
    saving: put.isPending, edit, insert, goToLine, discard, save,
  }
}

type Pane = 'edit' | 'preview'

function SessionContextEditor({ file, refetch }: { file: SessionContextFile; refetch: () => Promise<unknown> }) {
  const state = useSessionContextDraft(file, refetch)
  const { content, problems, current } = state
  const writable = file.writable
  const marked = useMemo(() => new Set(problems.flatMap((p) => (p.line === null ? [] : [p.line]))), [problems])

  if (!state.started) {
    return <EmptyRules path={file.path} readOnlyReason={file.readOnlyReason} onAdd={writable ? () => state.edit(addRule('')) : undefined} />
  }
  return (
    <div data-slot="session-context-editor" data-reports-dirty="" className="flex flex-col gap-4">
      {!writable && <ReadOnlyNotice reason={file.readOnlyReason} />}
      {state.failure && writable && (
        <SaveFailureNotice failure={state.failure} showDisk={state.showDisk} onShowDisk={state.toggleDisk} onOverwrite={() => state.save(file.version)} />
      )}
      {state.showDisk && <DiskVersion content={file.content} />}
      {problems.length > 0 && <ProblemList problems={problems} onLine={state.goToLine} />}
      <PaneTabs pane={state.pane} onPane={state.setPane} />
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section
          data-slot="session-context-file"
          aria-label="context.yaml"
          className={cn('flex flex-col overflow-hidden rounded-lg border border-border bg-card', state.pane !== 'edit' && 'max-md:hidden')}
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <code className="font-mono text-[12px] break-all">{file.path}</code>
            <FileStatus problems={problems.length} current={current} dirty={state.dirty} />
            {writable && (
              <Button data-slot="session-context-add-rule" variant="outline" className="ml-auto" onClick={() => state.edit(addRule(content))}>
                <PlusIcon /> Add rule
              </Button>
            )}
          </div>
          <CodeEditor
            value={content}
            onChange={writable ? state.setDraft : undefined}
            readOnly={!writable}
            language="yaml"
            markedLines={marked}
            inputRef={state.inputRef}
            aria-label="context.yaml rules"
            className="h-[420px] rounded-none border-0"
          />
          {writable && <TokenChips onInsert={state.insert} />}
        </section>
        <SessionContextPreviewPanel
          preview={state.preview}
          role={state.role}
          onRole={state.setRole}
          pending={!current}
          className={cn(state.pane !== 'preview' && 'max-md:hidden')}
        />
      </div>
      <SaveBar
        writable={writable}
        hasProblems={problems.length > 0}
        dirty={state.dirty}
        saving={state.saving}
        canSave={writable && state.dirty && !state.saving && current && problems.length === 0}
        onDiscard={state.discard}
        onSave={() => state.save(file.version)}
      />
    </div>
  )
}

function PaneTabs({ pane, onPane }: { pane: Pane; onPane: (pane: Pane) => void }) {
  return (
    <div role="tablist" aria-label="Session context view" className="flex overflow-hidden rounded-md border border-[var(--control-border)] md:hidden">
      {(['edit', 'preview'] as const).map((value) => (
        <button
          key={value}
          type="button"
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
      <CodeEditor value={content} language="yaml" readOnly aria-label="context.yaml on disk" className="h-[200px]" />
    </div>
  )
}

function SaveBar(props: {
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
        {props.hasProblems ? 'Save is off while the file has problems.' : 'Applies from the next session launch. Squawk does not commit this file.'}
      </p>
      {props.writable && (
        <>
          <Button variant="outline" disabled={!props.dirty || props.saving} onClick={props.onDiscard}>Discard changes</Button>
          <Button data-slot="session-context-save" disabled={!props.canSave} onClick={props.onSave}>{props.saving ? 'Saving…' : 'Save'}</Button>
        </>
      )}
    </div>
  )
}

function FileStatus({ problems, current, dirty }: { problems: number; current: boolean; dirty: boolean }) {
  return (
    <span className="flex flex-wrap gap-1.5" aria-live="polite">
      {current && problems > 0 && (
        <Badge variant="outline" className="border-danger/45 text-[11px] text-danger">
          {problems} {problems === 1 ? 'problem' : 'problems'}
        </Badge>
      )}
      {current && problems === 0 && <Badge variant="outline" className="border-success/40 text-[11px] text-success">Valid</Badge>}
      {!current && <Badge variant="outline" className="text-[11px]">Checking…</Badge>}
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
          <li key={index} className="flex flex-wrap items-center gap-x-1 text-[13px]">
            {problem.line !== null && (
              <button
                type="button"
                data-slot="session-context-line"
                onClick={() => onLine(problem.line!)}
                className="min-h-11 text-link-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-8"
              >
                Line {problem.line}
              </button>
            )}
            {problem.line !== null && <span aria-hidden="true" className="text-soft-foreground">·</span>}
            {problem.rule !== null && <span className="text-muted-foreground">rule {problem.rule}:</span>}
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
          <Button variant="outline" onClick={onShowDisk}>{showDisk ? 'Hide the disk version' : 'Show the disk version'}</Button>
          <Button variant="outline" onClick={onOverwrite}>Overwrite it</Button>
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

function EmptyRules({ path, readOnlyReason, onAdd }: { path: string; readOnlyReason: string | null; onAdd: (() => void) | undefined }) {
  return (
    <div data-slot="session-context-empty" className="rounded-lg border border-border bg-card">
      <CenteredState
        icon={<FileStackIcon />}
        title="No project rules yet"
        heading="h2"
        subtitle={`Every session already starts with its handoff block. Add rules to put more text after it: a project brief, the contents of a doc, or instructions only workers get. Rules live in ${path}.`}
        actions={
          <>
            {onAdd && <Button onClick={onAdd}>Add the first rule</Button>}
            <Button variant="outline" asChild>
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
