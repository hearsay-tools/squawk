import { BoardPage } from '@/components/page-shell'

/** Lightweight route skeleton for both activity routes; independent of the feature chunk. */
export function ActivityLoading() {
  return (
    <BoardPage
      route="activity"
      density="sparse"
      rootProps={{ 'aria-busy': 'true' }}
      header={{ title: 'Activity' }}
    >
      <p data-slot="activity-loading" role="status" className="text-xs text-muted-foreground">
        Loading activity…
      </p>
    </BoardPage>
  )
}
