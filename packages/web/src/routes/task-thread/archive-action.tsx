import { projectAddress, runAddress } from '@/api/run-address'
import { useRunCacheWriter } from '@/api/use-run-cache-writer'
import { useMutation } from '@tanstack/react-query'
import { ArchiveRestoreIcon } from 'lucide-react'
import { useState } from 'react'

import { archiveRun } from '@/api/client'
import { ArchiveIcon } from '@/components/design-icons'
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
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'
import type { ApiRun } from '@open-mercato/cezar-api-client'

/**
 * THE archive action (`POST /api/runs/:id/archive`) — one implementation for the surfaces that
 * offer it (#281): the header's own button on all four tabs, the phone kebab entry and the
 * archive-blocker note. The same rule `use-finish-run.ts` states for Finish applies here for the same reason:
 * archiving is one mutation, and three buttons that happen to agree today are three buttons that
 * can stop agreeing.
 */
export function useArchiveRun(runId: string) {
  const writer = useRunCacheWriter()
  return useMutation({
    mutationFn: (archived: boolean) => archiveRun(runAddress(runId), archived),
    onSuccess: () => writer.invalidateAfter('runs', () => projectAddress()),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
}

/** Archive's label, and whether invoking it needs a confirmation. Unarchiving goes straight
 *  through — it restores a task to the list it came from, which is its own undo. */
export function archiveActionLabel(run: ApiRun): string {
  return run.archived ? 'Unarchive' : 'Archive task'
}

/** The confirm, verbatim from the kebab's own dialog so moving the control does not quietly
 *  reword it. Archiving is reversible, so this asks rather than warns. */
export function ArchiveConfirmDialog({
  run,
  open,
  onOpenChange,
  onConfirm,
}: {
  run: ApiRun
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-slot="task-confirmation" className="sm:max-w-[660px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Archive task?</AlertDialogTitle>
          <AlertDialogDescription>
            Move “
            <span className="font-medium text-foreground" title={runTitle(run)}>{runTitle(run)}</span>
            ” out of Active tasks. You can restore it from Archived.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-accent-strong text-accent-strong-foreground hover:brightness-[0.96]"
            onClick={onConfirm}
          >
            Archive task
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The standalone Archive control (#281) — the outline button in the header's fixed slot on every
 * tab, and beside an archive blocker's reason. Self-contained:
 * it owns its mutation and its confirm, so a host only has to decide WHERE it goes, never what it
 * does. `outline` rather than a CTA on purpose: filing a finished task away is housekeeping, and
 * the gold in this row belongs to the verb that moves the task forward.
 */
export function ArchiveButton({ run, className }: { run: ApiRun; className?: string | undefined }) {
  const [confirming, setConfirming] = useState(false)
  const archive = useArchiveRun(run.id)
  const label = archiveActionLabel(run)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        data-slot="archive-action"
        aria-label={label}
        title={run.archived ? 'Put this task back in Active tasks' : 'Move this task out of Active tasks'}
        disabled={archive.isPending}
        className={cn('h-11 gap-[7px] px-3', className)}
        onClick={() => (run.archived ? archive.mutate(false) : setConfirming(true))}
      >
        {run.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
        <span>{label}</span>
      </Button>
      <ArchiveConfirmDialog
        run={run}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => {
          archive.mutate(true)
          setConfirming(false)
        }}
      />
    </>
  )
}
