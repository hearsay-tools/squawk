/** Lightweight route skeleton for both activity routes; independent of the feature chunk. */
export function ActivityLoading() {
  return (
    <div data-route="activity" aria-busy="true" className="min-h-full w-full px-4 pb-6 md:px-9">
      <h1 className="pt-7 text-[26px] md:text-[28px] font-semibold tracking-tight leading-[1.2] text-foreground">Activity</h1>
      <p data-slot="activity-loading" role="status" className="mt-4 text-xs text-muted-foreground">
        Loading activity…
      </p>
    </div>
  )
}
