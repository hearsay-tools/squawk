import { FileQuestionIcon, FileWarningIcon, FileXIcon } from 'lucide-react'
import { FileSearchIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { ApiError, runFileRawUrl } from '@/api/client'
import { useRunFile } from '@/api/queries'
import type { WorktreeEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { highlight, highlightSync, langForPath, type SynToken } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

import { HtmlReportFrame } from '@/components/html-report-frame'
import { isHtmlPath } from '@/lib/html-report'
import { WrapToggle } from './diff-controls'
import { formatFileSize, previewKind } from './worktree-files'
import { Markdown } from '../task-thread/markdown'
import { followInApp } from '../task-thread/task-link'

/**
 * The Files tab's preview pane (R5 Step 1.6). Every state is honest about WHY there is no
 * text: images render inline from the server's raw mode (image extensions only — the server
 * refuses everything else as bytes), size-capped files say "too large", binary non-images
 * say "binary", and a 409 comes back in the server's own words. Text goes through the ONE
 * Shiki singleton with `langForPath`, plaintext fallback included.
 */
export function FilePreview({ runId, path, className }: { runId: string; path: string | null; className?: string | undefined }) {
  const entry = useRunFile(runId, path ?? undefined)

  if (path === null) {
    return (
      <Pane className={className}>
        <CenteredState
          icon={<FileSearchIcon size={16} />}
          tone="neutral"
          heading="h2"
          title="Select a file"
          subtitle="Pick a file from this task’s worktree to inspect its contents."
          className="[&_[data-slot=centered-state-tile]]:size-10 [&_[data-slot=centered-state-tile]]:border-0 [&_[data-slot=centered-state-tile]]:bg-transparent [&_[data-slot=centered-state-tile]]:text-accent-text [&_[data-slot=centered-state-tile]]:shadow-none [&_h2]:text-xl"
        />
      </Pane>
    )
  }
  if (entry.isPending) {
    return (
      <Pane className={className}>
        <p data-slot="file-preview-loading" className="px-4 py-6 text-center text-xs text-soft-foreground">
          Loading {path}…
        </p>
      </Pane>
    )
  }
  if (entry.isError) {
    // A 409 is the server's answer ("symlinks are not served: …"), not an outage.
    const refused = entry.error instanceof ApiError && entry.error.status === 409
    return (
      <Pane className={className}>
        <CenteredState
          icon={refused ? <FileXIcon /> : <TriangleAlertIcon size={16} />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'Cannot preview this file' : 'Could not load this file'}
          subtitle={entry.error.message}
        />
      </Pane>
    )
  }
  if (entry.data.type !== 'file') {
    // An exact-path entry (or a stale file selection) can resolve to a directory.
    return (
      <Pane className={className}>
        <CenteredState
          icon={<FileQuestionIcon />}
          tone="neutral"
          heading="h2"
          title="Choose a file inside this directory"
          subtitle="Expand the folder in the tree, or enter the full path to a file."
        />
      </Pane>
    )
  }
  return <FileEntryView runId={runId} entry={entry.data} className={className} />
}

/** Strip a managed worktree root prefix so file headers show clean repo-relative paths. */
export function formatDisplayFilePath(
  entryPath: string,
  worktreePath?: string | null,
  relativeHint?: string | null,
): string {
  const trimmedWorktree = worktreePath?.replace(/\/+$/, '')
  if (trimmedWorktree && entryPath.startsWith(`${trimmedWorktree}/`)) {
    return entryPath.slice(trimmedWorktree.length + 1)
  }
  const worktreeMatch = /^.*\/\.ai\/(?:cezar|squawk)\/worktrees\/[^/]+\/(.+)$/.exec(entryPath)
  if (worktreeMatch?.[1]) return worktreeMatch[1]
  if (entryPath.startsWith('/') && relativeHint && !relativeHint.startsWith('/')) {
    const cleanHint = relativeHint.replace(/^\.?\//, '')
    if (cleanHint && (entryPath === `/${cleanHint}` || entryPath.endsWith(`/${cleanHint}`))) {
      return cleanHint
    }
  }
  return entryPath
}

function resolveEntryPresentation(
  entry: Extract<WorktreeEntry, { type: 'file' }>,
  documentPreview: boolean,
  source: boolean,
) {
  const markdown = documentPreview && /\.(?:md|markdown)$/i.test(entry.path)
  const html = documentPreview && isHtmlPath(entry.path)
  const safeImage = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(entry.path)
  const kind = documentPreview && safeImage && entry.size <= 10 * 1024 * 1024 ? 'image' : previewKind(entry)
  const toggle = (markdown || html) && kind === 'text'
  const showImage = kind === 'image' && (!documentPreview || safeImage)
  const rendered: 'markdown' | 'html' | null = source ? null : markdown ? 'markdown' : html ? 'html' : null
  return { html, kind, toggle, showImage, rendered }
}

export function FileEntryView({
  runId,
  entry,
  displayPath,
  className,
  imageUrl,
  downloadUrl,
  snapshot,
  readerHref,
  documentPreview = false,
}: {
  runId: string
  entry: Extract<WorktreeEntry, { type: 'file' }>
  displayPath?: string | undefined
  className?: string | undefined
  imageUrl?: string
  downloadUrl?: string
  snapshot?: string
  /** Where "Open reader" goes for an HTML file (hearsay-tools/cezarion#2400). */
  readerHref?: string | undefined
  documentPreview?: boolean
}) {
  const [source, setSource] = useState(false)
  // Wrapped by default, like the Changes diff: a long line reads in place instead of off the edge.
  const [wrap, setWrap] = useState(true)
  const shownPath = displayPath ?? formatDisplayFilePath(entry.path)
  const view = resolveEntryPresentation(entry, documentPreview, source)
  const hasActions = Boolean(snapshot || downloadUrl || view.toggle)
  const code = !view.showImage && view.kind === 'text' && view.rendered === null
  return (
    <Pane className={className}>
      <header
        data-slot="file-preview-head"
        className={cn('flex min-h-11 items-center gap-2 border-b border-border bg-muted/40 ps-4 text-xs', code ? 'pe-2 py-1' : 'pe-4 py-2.5')}
      >
        <span className="min-w-0 truncate font-mono font-medium text-foreground" title={shownPath}>
          {shownPath}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{formatFileSize(entry.size)}</span>
        {/* Compact beside the size on a desktop mouse; the 44px target on a phone or touch pointer. */}
        {code ? <WrapToggle wrap={wrap} onWrapChange={setWrap} className="size-8 rounded-md max-md:size-11 pointer-coarse:size-11" /> : null}
      </header>
      {hasActions ? <PreviewActions snapshot={snapshot} downloadUrl={downloadUrl} source={view.toggle ? source : null}
        onSource={() => setSource(value => !value)} readerHref={view.html && view.kind === 'text' ? readerHref : undefined} /> : null}
      <EntryBody runId={runId} entry={entry} kind={view.kind} showImage={view.showImage}
        rendered={view.rendered} imageUrl={imageUrl} wrap={wrap} />
    </Pane>
  )
}

function EntryBody({ runId, entry, kind, showImage, rendered, imageUrl, wrap }: {
  runId: string
  entry: Extract<WorktreeEntry, { type: 'file' }>
  kind: ReturnType<typeof previewKind>
  showImage: boolean
  rendered: 'markdown' | 'html' | null
  imageUrl?: string | undefined
  wrap: boolean
}) {
  if (showImage) return (
    <div className="flex justify-center p-4">
      {/* Raw bytes from the same origin the JSON came from — no auth story to get wrong. */}
      <img data-slot="file-preview-image" src={imageUrl ?? runFileRawUrl(runId, entry.path)} alt={entry.path} className="max-h-[70vh] max-w-full rounded-sm" />
    </div>
  )
  if (kind === 'too-large') return <CenteredState icon={<FileWarningIcon />} tone="neutral" heading="h2" title="Too large to preview"
    subtitle={`${formatFileSize(entry.size)} — past the preview cap. Open it in your editor instead.`} />
  if (kind === 'binary') return <CenteredState icon={<FileQuestionIcon />} tone="neutral" heading="h2" title="Binary file"
    subtitle={`${formatFileSize(entry.size)} of binary data — no text preview.`} />
  if (rendered === 'markdown') return <div className="p-4"><Markdown document>{entry.content ?? ''}</Markdown></div>
  if (rendered === 'html') return <HtmlReportFrame html={entry.content ?? ''} title={`Report: ${entry.path}`} className="h-[70vh]" />
  return <CodeLines path={entry.path} text={entry.content ?? ''} wrap={wrap} />
}

function PreviewActions({ snapshot, downloadUrl, source, onSource, readerHref }: {
  snapshot?: string | undefined
  downloadUrl?: string | undefined
  /** null: the file has no rendered view to toggle. */
  source: boolean | null
  onSource: () => void
  readerHref?: string | undefined
}) {
  return <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
    {snapshot ? <span>Published snapshot · {snapshot}</span> : null}
    {downloadUrl ? <a className="inline-flex min-h-11 items-center text-accent-text underline" href={downloadUrl}>Download</a> : null}
    {source !== null ? <button className="min-h-11 rounded px-2 text-accent-text underline focus-visible:ring-2" onClick={onSource}>{source ? 'Preview' : 'View source'}</button> : null}
    {readerHref ? <ReaderLink href={readerHref} /> : null}
  </div>
}

function ReaderLink({ href }: { href: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  return <a className="inline-flex min-h-11 items-center px-2 text-accent-text underline focus-visible:ring-2" href={href}
    onClick={event => followInApp(event, navigate, href, location)}>Open reader</a>
}

/** The preview card — same bordered grammar as the diff facade's file cards. */
function Pane({ className, children }: { className?: string | undefined; children: React.ReactNode }) {
  return (
    <section data-slot="file-preview" className={cn('flex flex-col overflow-hidden rounded-lg border border-border bg-card', className)}>
      {children}
    </section>
  )
}

/** Past this many lines highlighting is skipped — plaintext beats jank (diff-view.tsx's cap). */
const HIGHLIGHT_MAX_LINES = 1500

/** Tokens for the whole file through the shared singleton: sync when the grammar is resident,
 *  async load once when not, plaintext for unknown/oversized files. Same shape as the diff
 *  facade's useFileTokens — this one owns whole files instead of patch lines. */
function useFileTokens(path: string, text: string): SynToken[][] {
  const plain = useMemo(() => text.split('\n').map((line) => [{ content: line }]), [text])
  const lang = useMemo(() => langForPath(path), [path])
  const oversized = plain.length > HIGHLIGHT_MAX_LINES
  const [loaded, setLoaded] = useState<{ key: string; tokens: SynToken[][] } | null>(null)

  useEffect(() => {
    if (lang === null || oversized) return
    let cancelled = false
    void highlight(text, lang).then((result) => {
      if (!cancelled) setLoaded({ key: `${path}\0${text}`, tokens: result.tokens })
    })
    return () => {
      cancelled = true
    }
  }, [path, text, lang, oversized])

  if (lang === null || oversized) return plain
  if (loaded?.key === `${path}\0${text}`) return loaded.tokens
  return highlightSync(text, lang)?.tokens ?? plain
}

/** `wrap`: long lines break inside the pane; off, rows grow as wide as the longest line. */
export function CodeLines({ path, text, wrap = false }: { path: string; text: string; wrap?: boolean }) {
  const tokens = useFileTokens(path, text)
  return (
    <div
      data-slot="file-preview-code"
      data-lang={langForPath(path) ?? 'plaintext'}
      className="overflow-x-auto overscroll-x-contain py-2 font-mono text-xs leading-[1.7] [scrollbar-width:thin]"
    >
      {/* Rows as wide as the longest line (`w-max`, at least the pane): a long line scrolls with
          its right padding intact instead of running into the pane edge, and the sticky gutter
          keeps the line numbers in view while the code scrolls under it. */}
      <div className={wrap ? 'min-w-0' : 'w-max min-w-full'}>
      {tokens.map((line, index) => (
        <div key={index} className="flex">
          <span className="sticky left-0 w-14 shrink-0 select-none bg-card pr-3 pl-4 text-right tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <span className={cn('min-w-0 flex-1 pr-6', wrap ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre')}>
            {line.map((token, tokenIndex) => (
              <span
                key={tokenIndex}
                style={token.color !== undefined ? { color: token.color } : undefined}
              >
                {token.content}
              </span>
            ))}
          </span>
        </div>
      ))}
      </div>
    </div>
  )
}
