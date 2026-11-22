import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { alreadyReloadedFor, hasUnsavedText, observeServerVersion, reloadForVersion, trackTyping } from '@/lib/version-reload'

/** How often a waiting reload checks again whether the unsaved text is gone. */
const RETRY_MS = 2000

type Phase = 'reloading' | 'waiting-for-text' | 'manual'

/**
 * Reloads the cockpit when the server version changes (rules in `lib/version-reload.ts`), and
 * says so in the banner row: "Squawk was updated" with what happens next.
 */
export function VersionReloadNotice({ reload }: { reload?: () => void }) {
  const version = useHealth().data?.version
  const page = useQueryClient()
  const [target, setTarget] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('reloading')

  // From the first render on, so text typed before an upgrade counts.
  useEffect(() => trackTyping(), [])

  useEffect(() => {
    const changed = observeServerVersion(page, version)
    if (changed !== null) setTarget(changed)
  }, [page, version])

  useEffect(() => {
    if (target === null) return
    if (alreadyReloadedFor(target)) {
      setPhase('manual')
      return
    }
    const attempt = (): boolean => {
      if (hasUnsavedText()) {
        setPhase('waiting-for-text')
        return false
      }
      setPhase('reloading')
      reloadForVersion(target, reload)
      return true
    }
    if (attempt()) return
    const timer = window.setInterval(() => {
      if (attempt()) window.clearInterval(timer)
    }, RETRY_MS)
    return () => window.clearInterval(timer)
  }, [target, reload])

  if (target === null) return null
  return (
    <div
      data-slot="version-reload"
      data-phase={phase}
      role="status"
      className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/50 px-4 py-1 text-sm text-foreground"
    >
      <span>
        {phase === 'reloading'
          ? `Squawk was updated to ${target}. Reloading…`
          : phase === 'waiting-for-text'
            ? `Squawk was updated to ${target}. It reloads once your unsent text is sent or cleared.`
            : `Squawk was updated to ${target}. Reload to use the new version.`}
      </span>
      {phase === 'reloading' ? null : (
        <Button type="button" size="sm" variant="outline" className="ml-auto max-md:min-h-11" data-action="version-reload" onClick={() => reloadForVersion(target, reload)}>
          Reload now
        </Button>
      )}
    </div>
  )
}
