import { TablePage } from '@/components/page-shell'

/** Lightweight route skeleton; deliberately independent of the feature chunk. */
export function SkillsLoading() {
  return (
    <TablePage
      route="skills"
      density="sparse"
      rootProps={{ 'aria-busy': 'true' }}
      header={{
        title: 'Skills',
        subtitle: 'The skills each agent loads in this project, as its runner reports them.',
      }}
    >
      <p data-slot="skills-loading" role="status" className="text-xs text-muted-foreground">
        Loading skills…
      </p>
      <div aria-hidden="true" className="mt-4 flex flex-col gap-[22px] motion-safe:animate-pulse">
        <div className="h-11 rounded-lg border border-border bg-card" />
        <div className="h-80 rounded-xl border border-border bg-card" />
      </div>
    </TablePage>
  )
}
