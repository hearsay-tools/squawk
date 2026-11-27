import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'
import { TablePage } from '@/components/page-shell'

/**
 * The GitHub tab's loading state, in its own module ON PURPOSE (same rule as ThreadLoading):
 * it is both the route's fetch-pending state and the `Suspense` fallback for the lazily-loaded
 * github chunk (routes.tsx) — and the fallback must not import anything from that chunk, or
 * the split that keeps the markdown stack off the main bundle quietly disappears.
 */
export function GithubLoading() {
  return (
    <TablePage route="github" density="sparse" flushPadding>
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading GitHub…"
        subtitle="Fetching open issues and pull requests."
      />
    </TablePage>
  )
}
