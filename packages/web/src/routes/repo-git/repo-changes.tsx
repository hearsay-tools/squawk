import { FileDiffIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useMemo, useRef, useState } from 'react'

import { ApiError } from '@/api/client'
import { useRepoChanges } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { canPreviewMarkdown, Diff, type DiffHandle, type DiffMode } from '@/components/diff'
import { useIsDesktop } from '@/lib/use-desktop'

import { ChangesTree } from '../task-git/changes-tree'
import { DiffViewToggles, MarkdownPreviewToggle } from '../task-git/diff-controls'
import { buildFileTree } from '../task-git/file-tree'
import { AnimatedDiffStat } from '../task-git/git-toolbar'

/**
 * The repo view's Changes segment (R5 Step 1.7): the MAIN working tree's uncommitted diff
 * over `GET /api/repo/changes`, rendered by the exact components the task Changes tab uses —
 * `buildFileTree` + `ChangesTree` + the `<Diff>` facade — with the same unified/split + wrap
 * toggles. No git action bar here: committing on the main tree is the CLI's business; the
 * cockpit's commit/push flows belong to task worktrees (task-changes.tsx).
 *
 * Below `md` the same rule as the task tab applies: unified forced, wrap still switchable, tree stacked above the diff — the
 * per-file sticky headers carry the names.
 */
export function RepoChangesSection() {
  const changes = useRepoChanges()
  const desktop = useIsDesktop()

  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(true)
  const [preview, setPreview] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const diffRef = useRef<DiffHandle | null>(null)

  // A 409 is the server's answer ("not a git repository"), not an outage.
  const refused = changes.isError && changes.error instanceof ApiError && changes.error.status === 409

  const files = changes.data?.files ?? []
  const tree = useMemo(() => buildFileTree(files), [files])
  const hasMarkdown = useMemo(() => files.some(canPreviewMarkdown), [files])

  const effectiveMode: DiffMode = desktop ? mode : 'unified'

  // Through the facade's handle, not the DOM — see the task Changes tab's note.
  const selectFile = (path: string) => {
    setSelected(path)
    diffRef.current?.scrollToPath(path)
  }

  return (
    <section data-slot="repo-changes" className="flex min-h-0 flex-1 flex-col">
      {changes.isPending ? (
        <p data-slot="changes-loading" className="px-4 py-6 text-center text-xs text-muted-foreground md:px-9">
          Loading changes…
        </p>
      ) : changes.isError ? (
        <CenteredState
          icon={refused ? <FileDiffIcon size={16} /> : <TriangleAlertIcon size={16} />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'No changes to show' : 'Could not load the changes'}
          subtitle={changes.error.message}
        />
      ) : files.length === 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={16} />}
          tone="neutral"
          heading="h2"
          title="Working tree clean"
          subtitle="No uncommitted changes in the main working tree. Edits show up here as they happen."
        />
      ) : (
        <>
          {/* Full width above both columns, like the task Changes toolbar: the Changed files card
              and the first diff card then start on one baseline. */}
          <div data-slot="repo-changes-toolbar" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-4 md:px-9 [&_button]:min-h-11">
            {changes.data ? <AnimatedDiffStat stat={changes.data.stat} /> : null}
            <span className="ml-auto flex items-center gap-2">
              {/* Every width, like the task toolbar's — see `MarkdownPreviewToggle`. */}
              {hasMarkdown ? <MarkdownPreviewToggle preview={preview} onPreviewChange={setPreview} /> : null}
              {/* Same rule as the task toolbar: unified/split exists ≥md only (phones force
                  unified); the wrap switch stays at every width. */}
              <span className="flex items-center gap-1.5">
                <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} />
              </span>
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col items-stretch gap-5 px-4 pb-9 pt-0 [--diff-sticky-top:1rem] md:flex-row md:items-start md:px-9">
            {/* Same deal as the task Changes tab: sticky AND its own scroller, so a long file list
                never has to drag the diff to the bottom to show its last row. */}
            <aside
              data-slot="changes-tree-pane"
              className="md:sticky md:top-4 md:max-h-[calc(100dvh_-_64px_-_var(--diff-sticky-top)_-_1rem)] w-full md:w-60 shrink-0 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-3.5 lg:w-[288px]"
            >
              <h2 data-slot="changes-tree-heading" className="mb-3 border-b border-border pb-3 text-xs font-semibold">Changed files</h2>
              <ChangesTree root={tree} selected={selected} onSelect={selectFile} />
            </aside>
            <Diff
              files={files}
              viewRef={diffRef}
              mode={effectiveMode}
              wrap={wrap}
              // No file route serves the main checkout, so the preview shows the patch's new side
              // and no image: `loadFileText` and `imageSrc` stay unwired here.
              preview={preview}
              // The toolbar above shows the animated total; the diff does not repeat it.
              totals={false}
              className="min-w-0 flex-1"
            />
          </div>
        </>
      )}
    </section>
  )
}
