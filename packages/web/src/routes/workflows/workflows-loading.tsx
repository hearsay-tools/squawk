import { SplitPage } from '@/components/page-shell'

/** Lightweight route skeleton; deliberately independent of the feature chunk. */
export function WorkflowsLoading() {
  return (
    <SplitPage
      route="workflows"
      density="sparse"
      rootProps={{ 'aria-busy': 'true' }}
      header={{
        title: 'Workflows',
        subtitle: 'Portable skill chains. Steps run from top to bottom.',
      }}
    >
      <p data-slot="workflows-loading" role="status" className="text-xs text-muted-foreground">
        Loading workflows…
      </p>
      <div aria-hidden="true" className="mt-4 flex flex-col gap-[22px] motion-safe:animate-pulse">
        <div className="h-11 rounded-lg border border-border bg-card" />
        <div className="h-80 rounded-xl border border-border bg-card" />
      </div>
    </SplitPage>
  )
}
