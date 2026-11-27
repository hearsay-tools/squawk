import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'
import { ReadingPage } from '@/components/page-shell'

/**
 * The thread's loading state, in its own module ON PURPOSE: it is both the route's
 * fetch-pending state and the `Suspense` fallback for the lazily-loaded thread chunk
 * (routes.tsx) — and the fallback must not import anything from that chunk, or the split
 * that keeps Streamdown/remark off the main bundle quietly disappears.
 */
export function ThreadLoading() {
  return (
    <ReadingPage route="task-thread" density="sparse" flushPadding>
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading task…"
        subtitle="Fetching the run and its session transcript."
      />
    </ReadingPage>
  )
}
