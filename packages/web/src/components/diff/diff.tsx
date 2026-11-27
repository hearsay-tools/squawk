import { useEffect, useImperativeHandle, useRef, useState, type ComponentType } from 'react'

import type { DiffStat } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { cn } from '@/lib/utils'

import { DiffTotals } from './diff-totals'
import { ImagePreview, shouldPreviewImage } from './image-preview'
import type { DiffFileChange, DiffProps } from './types'

/**
 * Diff facade with local props and a lazy renderer. Keep parser, word diff and Shiki off the
 * main chunk. DiffFallback renders plain patch text with the same props when loading fails;
 * engine swaps stay behind this facade.
 */
export function Diff(props: DiffProps) {
  const [engine, setEngine] = useState<{ View: ComponentType<DiffProps> } | 'failed' | null>(null)
  useEffect(() => {
    let cancelled = false
    import('./diff-view').then(
      (module) => {
        if (!cancelled) setEngine({ View: module.DiffView })
      },
      () => {
        if (!cancelled) setEngine('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // The empty state needs no engine — render it synchronously, chunk or no chunk.
  if (props.files.length === 0) {
    return (
      <p data-slot="diff-empty" className={cn('px-1 text-xs text-muted-foreground', props.className)}>
        No changes.
      </p>
    )
  }
  if (engine === 'failed') return <DiffFallback {...props} />
  if (engine === null) {
    return (
      <p data-slot="diff-loading" className={cn('px-1 text-xs text-muted-foreground', props.className)}>
        Loading diff…
      </p>
    )
  }
  return <engine.View {...props} />
}

/**
 * The zero-dependency fallback: same props, raw patch text with `+`/`-` line tints from the
 * theme tokens. No parser, no highlighter, no lazy import — nothing here can fail the way
 * the engine chunk can. Split mode degrades to unified and Markdown `preview` to the plain
 * patch; that is documented degradation, not a bug.
 */
export function DiffFallback({ files, wrap = false, imageSrc, onOpenInApp, viewRef, totals = true, actions, className }: DiffProps) {
  const stat: DiffStat = {
    adds: files.reduce((sum, file) => sum + file.adds, 0),
    dels: files.reduce((sum, file) => sum + file.dels, 0),
    files: files.length,
  }
  // The fallback never virtualizes, so every file IS in the DOM — the handle a consumer's
  // file tree calls resolves straight to the element. Without this the tree would silently
  // stop scrolling whenever the engine chunk failed to load. Matched on `dataset` rather than
  // an attribute selector, for the reasons `diff-view.tsx`'s `findFileElement` spells out
  // (this stays inline rather than importing that helper: it lives in the lazy engine chunk,
  // and the fallback exists precisely for when that chunk is unreachable).
  const root = useRef<HTMLDivElement | null>(null)
  useImperativeHandle(viewRef, () => ({
    scrollToPath: (path: string) => {
      for (const element of root.current?.querySelectorAll<HTMLElement>('[data-slot="diff-file"]') ?? []) {
        if (element.dataset.path === path) {
          element.scrollIntoView({ block: 'start', behavior: 'smooth' })
          return
        }
      }
    },
  }))
  return (
    <div ref={root} data-slot="diff" data-fallback="true" className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div data-slot="diff-header" hidden={!totals && !actions} className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1.5 px-1">
        <DiffTotals stat={stat} hidden={!totals} />
        {actions ? <div data-slot="diff-actions" className="ms-auto flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {files.map((file) => (
        <FallbackFile
          key={`${file.oldPath ?? ''}→${file.path}`}
          file={file}
          wrap={wrap}
          imageSrc={imageSrc}
          onOpenInApp={onOpenInApp}
        />
      ))}
    </div>
  )
}

function FallbackFile({
  file,
  wrap,
  imageSrc,
  onOpenInApp,
}: {
  file: DiffFileChange
  wrap: boolean
  imageSrc?: ((path: string) => string) | undefined
  onOpenInApp?: ((path: string) => void) | undefined
}) {
  const fullPath = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  return (
    <section data-slot="diff-file" data-path={file.path} className="min-w-0 overflow-clip rounded-md border border-border bg-card">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2">
        <span data-slot="diff-file-path" title={fullPath} className="min-w-0 wrap-anywhere font-mono text-xs font-medium">
          {fullPath}
        </span>
        <span className="ml-auto shrink-0">
          <DiffStatLabel stat={{ adds: file.adds, dels: file.dels, files: 1 }} className="text-xs" />
        </span>
      </header>
      {shouldPreviewImage(file) ? (
        <ImagePreview file={file} imageSrc={imageSrc} onOpenInApp={onOpenInApp} />
      ) : file.binary ? (
        <p className="px-4 py-2.5 text-xs text-muted-foreground">Binary file — no text diff.</p>
      ) : file.patch === '' ? (
        <p className="px-4 py-2.5 text-xs text-muted-foreground">No content changes (metadata only).</p>
      ) : (
        <pre
          className={cn(
            'py-2 font-mono text-xs leading-[1.7]',
            wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto whitespace-pre',
          )}
        >
          {file.patch.split('\n').map((line, index) => (
            <span
              key={index}
              className={cn(
                'block px-4',
                line.startsWith('+') && !line.startsWith('+++') && 'bg-diff-add',
                line.startsWith('-') && !line.startsWith('---') && 'bg-diff-del',
                line.startsWith('@@') && 'text-muted-foreground',
              )}
            >
              {line}
              {line === '' ? ' ' : ''}
            </span>
          ))}
        </pre>
      )}
    </section>
  )
}
