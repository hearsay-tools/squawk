import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { controlLocation } from '@open-mercato/cezar-api-client/contract/control-locations'
import { openRunIn, reclaimRunWorktree, reclaimWorktrees } from '@/api/client'
import { queryKeys, useOpenTargets, useWorktrees } from '@/api/queries'
import type { WorktreeInfo, WorktreeReclaimBlocker } from '@open-mercato/cezar-api-client'
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
import { BrushIcon } from 'lucide-react'
import { FolderOpenIcon } from '@/components/design-icons'
import { toast } from '@/components/ui/toaster'
import { formatMem } from '@/lib/tasks-table'
import { shortAge, withAgo } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

function sumSizeBytes(rows: readonly WorktreeInfo[]): number | null {
  if (rows.some((row) => row.sizeBytes === null)) return null
  return rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
}

function blockerLabel(blocker: WorktreeReclaimBlocker): string {
  if (blocker.kind === 'dirty') return `${blocker.uncommittedFiles} uncommitted`
  if (blocker.kind === 'detached-head') return 'detached HEAD'
  if (blocker.kind === 'submodules') return 'has submodules'
  return 'broken worktree'
}

function blockerDetail(blocker: WorktreeReclaimBlocker): string {
  if (blocker.kind === 'dirty') {
    const files = `${blocker.uncommittedFiles} uncommitted file${blocker.uncommittedFiles === 1 ? '' : 's'}`
    return blocker.detachedHead ? `${files} and a detached HEAD on no branch` : files
  }
  if (blocker.kind === 'detached-head') return 'a detached HEAD whose commit is on no branch'
  if (blocker.kind === 'submodules') return 'initialized submodules that Git will not remove without force'
  return 'an unregistered or broken Git worktree directory'
}

function blockedReasonsSummary(rows: readonly WorktreeInfo[]): string {
  const dirty = rows.some((row) => row.reclaimBlocker?.kind === 'dirty')
  const detached = rows.some((row) => row.reclaimBlocker?.kind === 'detached-head' || (row.reclaimBlocker?.kind === 'dirty' && row.reclaimBlocker.detachedHead))
  const submodules = rows.some((row) => row.reclaimBlocker?.kind === 'submodules')
  const invalid = rows.some((row) => row.reclaimBlocker?.kind === 'invalid')
  const parts = [
    ...(dirty ? ['uncommitted work'] : []),
    ...(detached ? ['a detached HEAD'] : []),
    ...(submodules ? ['initialized submodules'] : []),
    ...(invalid ? ['a broken checkout'] : []),
  ]
  if (parts.length <= 1) return parts[0] ?? 'uncommitted work'
  return `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`
}

function formatReclaimToast(done: number, expected: number, discardWork: boolean): string {
  const kept = Math.max(0, expected - done)
  const why = discardWork ? 'in use or could not be removed' : 'uncommitted work or in use'
  if (done === 0) {
    if (kept === 0) return 'Nothing to reclaim — no finished worktrees exceed the keep limit'
    return discardWork
      ? 'Nothing was reclaimed — the worktrees past the keep limit are in use or could not be removed'
      : 'Nothing was reclaimed — the worktrees past the keep limit have uncommitted work or are in use'
  }
  const plural = done === 1 ? '' : 's'
  const suffix = kept > 0 ? ` · ${kept} kept: ${why}` : ''
  return `Reclaimed ${done} worktree${plural} (branch kept)${suffix}`
}

function formatReclaimLabel(count: number, bytes: number | null): string {
  if (count === 0) return 'Reclaim now'
  return bytes ? `Reclaim ${formatMem(bytes)} now` : `Reclaim ${count} now`
}

function formatDiscardLabel(allCount: number, allBytes: number | null, hasClean: boolean): string {
  const size = allBytes ? formatMem(allBytes) : String(allCount)
  return hasClean ? `Discard & reclaim all ${size}` : `Discard & reclaim ${size}`
}

function reclaimButtonTitle(canReclaim: boolean, blockedCount: number): string | undefined {
  if (canReclaim) return undefined
  return blockedCount > 0
    ? 'No clean worktrees past the keep limit — use Discard & reclaim for blocked worktrees'
    : 'Nothing past the keep limit to reclaim'
}

function retentionSummaryText(keep: number): { prefix: string; suffix: string } {
  if (keep === 0) return { prefix: 'Retention is unlimited (', suffix: '), so nothing is reclaimed on its own.' }
  return {
    prefix: `Retention keeps the newest ${keep} finished checkout${keep === 1 ? '' : 's'} (`,
    suffix: ') and reclaims the rest.',
  }
}

function WorktreesBlockedBanner({
  blocked,
  discardLabel,
  disabled,
  onDiscard,
}: {
  blocked: readonly WorktreeInfo[]
  discardLabel: string
  disabled: boolean
  onDiscard: () => void
}) {
  const blockedBytes = sumSizeBytes(blocked)
  const plural = blocked.length === 1 ? '' : 's'
  const verb = blocked.length === 1 ? 'it has' : 'they have'
  return (
    <div data-slot="worktrees-blocked-banner" className="flex flex-col gap-[10px] border-b border-border bg-muted/40 px-[14px] py-[10px] md:flex-row md:items-center">
      <p className="min-w-0 flex-1 text-[12px] leading-[17px] text-foreground">
        {blocked.length} worktree{plural} past the keep limit
        {blockedBytes ? ` (${formatMem(blockedBytes)})` : ''}{' '}
        cannot be reclaimed automatically because {verb} {blockedReasonsSummary(blocked)}.
      </p>
      <button
        type="button"
        data-action="worktrees-discard-reclaim"
        disabled={disabled}
        onClick={onDiscard}
        className="inline-flex h-[28px] shrink-0 items-center gap-[5px] self-start rounded-[6px] border border-danger/40 px-[10px] text-[12px] font-medium text-danger hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-md:h-11 md:self-center"
      >
        <BrushIcon aria-hidden="true" className="size-[12px]" />
        {discardLabel}
      </button>
    </div>
  )
}

function WorktreesDialogs({
  confirmClean,
  onCloseClean,
  cleanCount,
  cleanBytes,
  reclaimLabel,
  onConfirmClean,
  discardBatch,
  onCloseDiscardBatch,
  onConfirmDiscardBatch,
  discardRow,
  onCloseRow,
  onConfirmRow,
}: {
  confirmClean: boolean
  onCloseClean: () => void
  cleanCount: number
  cleanBytes: number | null
  reclaimLabel: string
  onConfirmClean: () => void
  discardBatch: readonly WorktreeInfo[] | null
  onCloseDiscardBatch: () => void
  onConfirmDiscardBatch: (rows: readonly WorktreeInfo[]) => void
  discardRow: WorktreeInfo | null
  onCloseRow: () => void
  onConfirmRow: (row: WorktreeInfo) => void
}) {
  const batchBytes = discardBatch ? sumSizeBytes(discardBatch) : null
  const batchBlockedCount = discardBatch ? discardBatch.filter((row) => row.reclaimBlocker !== null).length : 0
  const batchHasClean = discardBatch ? discardBatch.some((row) => !row.reclaimBlocker) : false
  const batchLabel = discardBatch ? formatDiscardLabel(discardBatch.length, batchBytes, batchHasClean) : ''
  return (
    <>
      <AlertDialog open={confirmClean} onOpenChange={(open) => { if (!open) onCloseClean() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reclaim old worktrees?</AlertDialogTitle>
            <AlertDialogDescription>
              {cleanCount} finished worktree{cleanCount === 1 ? '' : 's'} beyond the keep limit
              {cleanBytes ? ` (${formatMem(cleanBytes)})` : ''} {cleanCount === 1 ? 'is' : 'are'} reclaimed now,
              directory only. Their branches are kept, so the work stays recoverable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction data-action="worktrees-confirm" onClick={onConfirmClean}>
              {reclaimLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardBatch !== null} onOpenChange={(open) => { if (!open) onCloseDiscardBatch() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes and reclaim worktrees?</AlertDialogTitle>
            <AlertDialogDescription>
              {discardBatch ? (
                <>
                  {discardBatch.length} finished worktree{discardBatch.length === 1 ? '' : 's'} beyond the keep limit
                  {batchBytes ? ` (${formatMem(batchBytes)})` : ''} will be reclaimed now.{' '}
                  Uncommitted files and detached-HEAD commits in {batchBlockedCount} blocked checkout{batchBlockedCount === 1 ? '' : 's'} will be permanently discarded.
                  Each task’s branch is kept.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              data-action="worktrees-discard-confirm"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => {
                if (discardBatch) onConfirmDiscardBatch(discardBatch)
                onCloseDiscardBatch()
              }}
            >
              {batchLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardRow !== null} onOpenChange={(open) => { if (!open) onCloseRow() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes and reclaim worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              {discardRow?.reclaimBlocker ? (
                <>
                  {discardRow.title} has {blockerDetail(discardRow.reclaimBlocker)}. Reclaiming removes the directory and permanently discards uncommitted or unbranched changes in it. The branch ({discardRow.branch ?? discardRow.runId.slice(0, 8)}) is kept.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-action="worktree-discard-confirm"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => {
                if (discardRow) onConfirmRow(discardRow)
                onCloseRow()
              }}
            >
              Discard &amp; reclaim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * Git → Cleanup: the worktrees card (#483, moved from Settings by issue 06 §3, reworked by issue
 * 08 §C). Lists every task worktree materialized on disk with its size, age and retention state
 * (`in use`, `reclaimable` past the keep limit, `kept · newest N` inside it, or the blocker that
 * prevents a clean reclaim). The per-row action is Reclaim: the DIRECTORY only, through
 * retention's own rule (`POST /worktrees/:runId/reclaim`); the branch stays. Clean rows reclaim
 * immediately; blocked rows confirm an explicit discard first. The header's "Reclaim N GB now"
 * sizes from clean past-keep rows only, while blocked past-keep rows surface in a banner with an
 * explicit "Discard & reclaim" dialog.
 */
export function WorktreesPanel() {
  const worktrees = useWorktrees()
  const targets = useOpenTargets()
  const folderTarget = targets.data?.targets.find((target) => target.id === 'finder')
  const openFolder = useMutation({
    mutationFn: (runId: string) => openRunIn(runId, folderTarget!.id),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const queryClient = useQueryClient()
  const [confirmClean, setConfirmClean] = useState(false)
  const [discardBatch, setDiscardBatch] = useState<readonly WorktreeInfo[] | null>(null)
  const [discardRow, setDiscardRow] = useState<WorktreeInfo | null>(null)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.worktrees }),
      queryClient.invalidateQueries({ queryKey: queryKeys.repoBranches }),
    ])

  const reclaim = useMutation({
    mutationFn: ({ runIds }: { expected: number; runIds?: string[] }) =>
      reclaimWorktrees(runIds ? { discardWork: true, runIds } : undefined),
    onSuccess: (result, { expected, runIds }) => {
      void refresh()
      toast(formatReclaimToast(result.reclaimed.length, expected, Boolean(runIds)))
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const reclaimOne = useMutation({
    mutationFn: ({ worktree, discardWork }: { worktree: WorktreeInfo; discardWork: boolean }) =>
      reclaimRunWorktree(worktree.runId, discardWork ? { discardWork: true } : undefined),
    onSuccess: (_result, { worktree }) => {
      void refresh()
      toast(`Reclaimed the worktree of ${worktree.title} (branch kept)`)
    },
    onError: (error: Error) => {
      void refresh()
      toast(error.message, { tone: 'danger' })
    },
  })

  if (worktrees.isPending) {
    return (
      <p data-slot="worktrees-loading" className="text-[13px] text-soft-foreground">
        Loading worktrees…
      </p>
    )
  }
  if (worktrees.isError) {
    return (
      <p data-slot="worktrees-error" className="text-[13px] text-danger">
        Worktrees did not load: {worktrees.error.message}
      </p>
    )
  }

  const { worktrees: rows, totalBytes, keep } = worktrees.data
  const busy = reclaim.isPending || reclaimOne.isPending
  const allPastKeep = rows.filter((row) => row.pastKeep)
  const cleanPastKeep = allPastKeep.filter((row) => !row.reclaimBlocker)
  const blockedPastKeep = allPastKeep.filter((row) => row.reclaimBlocker !== null)
  const canReclaim = cleanPastKeep.length > 0
  const cleanBytes = sumSizeBytes(cleanPastKeep)
  const allBytes = sumSizeBytes(allPastKeep)
  const reclaimLabel = formatReclaimLabel(cleanPastKeep.length, cleanBytes)
  const discardLabel = formatDiscardLabel(allPastKeep.length, allBytes, canReclaim)
  const headingSize = totalBytes ? formatMem(totalBytes) : null
  const summary = retentionSummaryText(keep)

  return (
    <section data-slot="worktrees-panel" aria-labelledby="worktrees-panel-title" className="flex flex-col rounded-[8px] border border-border">
      <div className="flex flex-col gap-[10px] border-b border-border px-[14px] py-[12px] md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <h2 id="worktrees-panel-title" className="text-[13px] font-semibold text-foreground">
            Worktrees on disk{headingSize ? ` · ${headingSize}` : ''}
          </h2>
          <p data-slot="worktrees-retention" className="text-xs leading-[17px] text-soft-foreground">
            {summary.prefix}
            <Link to="/settings/worktrees" data-slot="worktrees-retention-link" className="underline-offset-2 hover:text-foreground hover:underline">
              {controlLocation('worktrees', ' › ')}
            </Link>
            {summary.suffix}
            {' '}Reclaim removes the directory only; the branch stays, so its work stays recoverable.
          </p>
        </div>
        <button
          type="button"
          data-action="worktrees-reclaim-now"
          disabled={busy || !canReclaim}
          title={reclaimButtonTitle(canReclaim, blockedPastKeep.length)}
          onClick={() => setConfirmClean(true)}
          className="inline-flex h-[28px] shrink-0 items-center gap-[5px] self-start rounded-[6px] bg-muted px-[10px] text-[12px] font-medium text-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 disabled:hover:brightness-100 max-md:h-11 md:self-center"
        >
          <BrushIcon aria-hidden="true" className="size-[12px]" />
          {reclaimLabel}
        </button>
      </div>

      {blockedPastKeep.length > 0 ? (
        <WorktreesBlockedBanner
          blocked={blockedPastKeep}
          discardLabel={discardLabel}
          disabled={busy}
          onDiscard={() => setDiscardBatch(allPastKeep)}
        />
      ) : null}

      {rows.length === 0 ? (
        <p data-slot="worktrees-empty" className="px-[14px] py-[12px] text-[12.5px] text-soft-foreground">
          No task worktrees on disk.
        </p>
      ) : (
        <ul aria-label="Task worktrees on disk" className="flex flex-col">
          {rows.map((w) => (
            <WorktreeRow
              key={w.runId}
              worktree={w}
              keep={keep}
              disabled={busy}
              onOpen={folderTarget ? () => openFolder.mutate(w.runId) : undefined}
              opening={openFolder.isPending}
              onReclaim={() => {
                if (w.reclaimBlocker) setDiscardRow(w)
                else reclaimOne.mutate({ worktree: w, discardWork: false })
              }}
            />
          ))}
        </ul>
      )}

      <WorktreesDialogs
        confirmClean={confirmClean}
        onCloseClean={() => setConfirmClean(false)}
        cleanCount={cleanPastKeep.length}
        cleanBytes={cleanBytes}
        reclaimLabel={reclaimLabel}
        onConfirmClean={() => {
          reclaim.mutate({ expected: cleanPastKeep.length })
          setConfirmClean(false)
        }}
        discardBatch={discardBatch}
        onCloseDiscardBatch={() => setDiscardBatch(null)}
        onConfirmDiscardBatch={(batch) => {
          reclaim.mutate({ expected: batch.length, runIds: batch.map((row) => row.runId) })
        }}
        discardRow={discardRow}
        onCloseRow={() => setDiscardRow(null)}
        onConfirmRow={(row) => reclaimOne.mutate({ worktree: row, discardWork: true })}
      />
    </section>
  )
}

/** Statuses whose checkout a live or reviewable task still stands on. */
const IN_USE = new Set<WorktreeInfo['status']>(['queued', 'running', 'waiting', 'review'])

/** What retention will do with a row, in the listing's own terms (`reclaimable`, `pastKeep`, `reclaimBlocker`). */
export function retentionState(
  worktree: WorktreeInfo,
  keep: number,
): { label: string; tone: 'in-use' | 'blocked' | 'plain'; state: 'in-use' | 'blocked' | 'reclaimable' | 'kept' } {
  if (IN_USE.has(worktree.status) || !worktree.reclaimable) return { label: 'in use', tone: 'in-use', state: 'in-use' }
  if (worktree.reclaimBlocker) return { label: blockerLabel(worktree.reclaimBlocker), tone: 'blocked', state: 'blocked' }
  if (worktree.pastKeep) return { label: 'reclaimable', tone: 'plain', state: 'reclaimable' }
  return { label: keep > 0 ? `kept · newest ${keep}` : 'kept', tone: 'plain', state: 'kept' }
}

function WorktreeRow({
  worktree,
  keep,
  disabled,
  onOpen,
  opening,
  onReclaim,
}: {
  worktree: WorktreeInfo
  keep: number
  disabled: boolean
  onOpen?: (() => void) | undefined
  opening: boolean
  onReclaim: () => void
}) {
  const state = retentionState(worktree, keep)
  const age = shortAge(worktree.finishedAt ?? undefined)
  const status = worktree.status === 'review' ? 'at review' : age ? `${worktree.status} ${withAgo(age)}` : worktree.status
  const stateToneClass =
    state.tone === 'in-use'
      ? 'text-status-running'
      : state.tone === 'blocked'
        ? 'text-danger'
        : 'text-soft-foreground'
  const stateTitle = worktree.reclaimBlocker ? `Cannot auto-reclaim: ${blockerDetail(worktree.reclaimBlocker)}` : undefined
  const stateLabel = (
    <span
      data-slot="worktree-state"
      data-state={state.state}
      title={stateTitle}
      className={cn('text-xs', stateToneClass)}
    >
      {state.label}
    </span>
  )
  const iconButton = 'flex size-[28px] shrink-0 items-center justify-center rounded-[6px] text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-md:size-11'
  const reclaimAria = worktree.reclaimBlocker
    ? `Discard changes and reclaim the worktree of ${worktree.title} (branch kept)`
    : `Reclaim the worktree of ${worktree.title} (branch kept)`
  const reclaimTitle = worktree.reclaimBlocker
    ? 'Discard changes and reclaim the directory (branch kept)'
    : 'Reclaim the directory (branch kept)'
  return (
    <li data-slot="worktree-row" data-run={worktree.runId} className="flex min-h-[44px] items-center gap-[12px] border-b border-border px-[14px] py-[4px] last:border-0">
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate text-[12.5px] text-foreground" title={worktree.title}>{worktree.title}</span>
        <span className="truncate font-mono text-xs text-soft-foreground">
          {worktree.branch ?? worktree.runId.slice(0, 8)} · {status}
          <span className="md:hidden"> · {state.label}</span>
        </span>
      </div>
      <span data-slot="worktree-size" className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {worktree.sizeBytes !== null ? formatMem(worktree.sizeBytes) || '0 kB' : '—'}
      </span>
      <span className="hidden shrink-0 md:inline">{stateLabel}</span>
      {onOpen ? (
        <button type="button" className={iconButton} aria-label={`Open folder for ${worktree.title}`} title="Open folder" disabled={opening} onClick={onOpen}>
          <FolderOpenIcon aria-hidden="true" className="size-[13px]" />
        </button>
      ) : null}
      {/* Reclaim is the directory only (issue 08 §B4): the branch stays. Blocked rows confirm discard first. */}
      {state.tone === 'in-use' ? null : (
        <button
          type="button"
          data-action="worktree-reclaim"
          aria-label={reclaimAria}
          title={reclaimTitle}
          disabled={disabled}
          onClick={onReclaim}
          className={cn(iconButton, worktree.reclaimBlocker && 'text-danger hover:text-danger')}
        >
          <BrushIcon aria-hidden="true" className="size-[13px]" />
        </button>
      )}
    </li>
  )
}
