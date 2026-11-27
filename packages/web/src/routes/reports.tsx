import { QueryClientContext } from '@tanstack/react-query'
import { productCommand } from '@/lib/product-name'
import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { useArtifact } from '@/api/queries'
import { useReports } from '@/api/reports'
import type { Report } from '@open-mercato/cezar-api-client/contract/reports'
import { REPORTS_QUERY_MAX } from '@open-mercato/cezar-api-client/contract/reports'
import { ArrowUpRightIcon, ChevronRightIcon, EyeIcon, FileTextIcon } from 'lucide-react'
import { SearchIcon } from '@/components/design-icons'
import { HtmlReportFrame } from '@/components/html-report-frame'
import {
  PageShellEmptyState,
  PageShellSparseFooter,
  PageShellSplitPane,
  SplitPage,
  pageShellDensity,
} from '@/components/page-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { shortAge } from '@/lib/format'
import { reportTitle } from '@/lib/report-title'
import { useIsDesktop } from '@/lib/use-desktop'
import { useSearchParamsWriter } from '@/lib/use-search-params-writer'
import { cn } from '@/lib/utils'
import './reports.css'

// Keep the source entry through both native Back and the reader's fallback navigation.
const positions = new Map<string, { scroll: number; row: string; pages: number }>()

/** Localized full date/time for the timestamp tooltip. */
function formatFullReportTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function ReportsRoute() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const [params, write] = useSearchParamsWriter()
  const q = (params.get('q') ?? '').slice(0, REPORTS_QUERY_MAX)
  const result = useReports(q)
  const scroller = useRef<HTMLDivElement>(null)
  const restored = useRef('')
  const key = location.pathname + location.search
  const reports = result.data?.pages.flatMap(page => page.reports) ?? []
  const [previewId, setPreviewId] = useState<string | null>(null)
  const desktop = useIsDesktop()

  useLayoutEffect(() => {
    if (!result.data || restored.current === key) return
    const saved = positions.get(key)
    const fallback = (location.state as { filesRestoreKey?: unknown } | null)?.filesRestoreKey === key
    if (!saved || !scroller.current || (navigationType !== 'POP' && !fallback)) { restored.current = key; return }
    const row = scroller.current.querySelector<HTMLAnchorElement>(`[data-report-id="${saved.row}"]`)
    if (result.isFetchNextPageError) {
      restored.current = key
      scroller.current.scrollTop = 0
      return
    }
    if ((!row || result.data.pages.length < saved.pages) && result.hasNextPage) {
      if (!result.isFetchingNextPage) void result.fetchNextPage()
      return
    }
    restored.current = key
    scroller.current.scrollTop = row ? saved.scroll : 0
    row?.focus({ preventScroll: true })
  }, [key, result.data, result.hasNextPage, result.isFetchingNextPage, result.isFetchNextPageError, result.fetchNextPage, location.state, navigationType])

  const search = (value: string) => write(current => {
    if (value) current.set('q', value.slice(0, REPORTS_QUERY_MAX))
    else current.delete('q')
    positions.delete(location.pathname + '?' + current.toString())
    return current
  })

  const selected = reports.find(report => report.id === previewId) ?? reports[0] ?? null
  const density = result.isPending ? 'full' : pageShellDensity(reports.length)

  return (
    <SplitPage
      route="reports"
      density={density}
      fillHeight
      bodyClassName="gap-4"
      header={{
        title: 'Reports',
        subtitle: 'Published HTML snapshots from tasks in this project.',
      }}
    >
      <div className="relative w-full shrink-0">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          maxLength={REPORTS_QUERY_MAX}
          aria-label="Search reports"
          placeholder="Search reports or source tasks…"
          value={q}
          onChange={event => search(event.target.value)}
          className="h-10 w-full rounded-lg border-border bg-card pl-9 text-sm max-md:h-11"
        />
      </div>

      {result.isPending ? (
        <div ref={scroller} data-slot="reports-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <p role="status" className="py-4 text-sm text-muted-foreground">Loading reports…</p>
        </div>
      ) : result.isError ? (
        <div ref={scroller} data-slot="reports-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5">
            <p className="text-sm font-medium text-foreground">Could not load reports</p>
            <p className="text-sm text-muted-foreground">{result.error.message}</p>
            <Button variant="outline" className="min-h-11" onClick={() => void result.refetch()}>Retry</Button>
          </div>
        </div>
      ) : reports.length === 0 ? (
        <div ref={scroller} data-slot="reports-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <PageShellEmptyState
            icon={<FileTextIcon />}
            title={q ? 'No matching reports' : 'No published reports yet'}
            description={q ? 'Try a different keyword or clear the search filter.' : (
              <>
                Publish an HTML snapshot with{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {productCommand()} artifact publish
                </code>{' '}
                to list it here.
              </>
            )}
            actions={q ? (
              <Button data-slot="reports-clear-search" variant="outline" className="min-h-11" onClick={() => search('')}>
                Clear search
              </Button>
            ) : (
              <Button variant="outline" className="min-h-11" asChild>
                <Link to="/new">Start a task</Link>
              </Button>
            )}
          />
        </div>
      ) : (
        <PageShellSplitPane
          list={
            <div ref={scroller} data-slot="reports-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <ul className="flex flex-col gap-1.5" aria-label="Reports">
                {reports.map(report => {
                  const isPreviewed = selected?.id === report.id
                  return (
                    <li
                      key={report.id}
                      data-slot="report-row"
                      data-selected={desktop && isPreviewed ? 'true' : undefined}
                      className={cn(
                        'reports-row flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors',
                        desktop && isPreviewed && 'border-accent-strong/60 bg-sidebar-row-selected/40',
                      )}
                    >
                      <FileTextIcon aria-hidden="true" className="reports-icon mt-0.5 size-4 shrink-0 self-start text-accent-text" />
                      <div className="reports-lines flex min-w-0 flex-1 flex-col gap-1">
                        <h2 className="flex min-w-0 text-[14px] leading-5 font-semibold text-foreground" title={reportTitle(report)}>
                          <Link
                            data-report-id={report.id}
                            className="reports-open text-foreground no-underline"
                            to={`/tasks/${report.runId}/report?artifact=${report.id}`}
                            state={{ readerFrom: key, filesRestoreKey: key }}
                            onClick={() => positions.set(key, { scroll: scroller.current?.scrollTop ?? 0, row: report.id, pages: result.data?.pages.length ?? 1 })}
                          >
                            <span className="min-w-0 truncate">{reportTitle(report)}</span>
                          </Link>
                        </h2>
                        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                          <Link
                            className="reports-task min-w-0 truncate text-xs text-muted-foreground no-underline hover:text-foreground hover:underline"
                            to={`/tasks/${report.runId}`}
                          >
                            <span className="min-w-0 truncate" title={report.taskTitle}>{report.taskTitle}</span>
                          </Link>
                          <span aria-hidden="true" className="shrink-0">·</span>
                          <time
                            className="shrink-0 tabular-nums"
                            dateTime={report.createdAt}
                            title={formatFullReportTimestamp(report.createdAt)}
                          >
                            {publishedAge(report.createdAt)}
                          </time>
                        </div>
                      </div>
                      <button
                        type="button"
                        data-slot="report-preview-select"
                        aria-label={`Preview ${reportTitle(report)}`}
                        aria-pressed={isPreviewed}
                        onClick={() => setPreviewId(report.id)}
                        className="reports-preview-btn hidden h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring md:inline-flex"
                      >
                        <EyeIcon aria-hidden="true" className="size-3.5" />
                      </button>
                      <ChevronRightIcon aria-hidden="true" data-slot="report-open-cue" className="reports-cue size-4 shrink-0 text-muted-foreground md:hidden" />
                    </li>
                  )
                })}
              </ul>
              {result.hasNextPage ? (
                <div className="mt-4">
                  <Button variant="outline" className="min-h-11" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>
                    Load more reports
                  </Button>
                </div>
              ) : null}
              {density === 'sparse' ? (
                <PageShellSparseFooter
                  summary={`${reports.length} published ${reports.length === 1 ? 'report' : 'reports'}. Select a row to open full screen or preview beside the list.`}
                />
              ) : null}
            </div>
          }
          detail={
            selected ? (
              <ReportPreviewPane report={selected} restoreKey={key} />
            ) : null
          }
        />
      )}
    </SplitPage>
  )
}

function ReportPreviewPane({ report, restoreKey }: { report: Report; restoreKey: string }) {
  const hasQueryClient = useContext(QueryClientContext) !== undefined
  return (
    <section
      data-slot="reports-preview-pane"
      aria-label={`Preview of ${reportTitle(report)}`}
      className="hidden min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card md:flex"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{reportTitle(report)}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {report.taskTitle} · {publishedAge(report.createdAt)}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild className="h-8 shrink-0">
          <Link
            to={`/tasks/${report.runId}/report?artifact=${report.id}`}
            state={{ readerFrom: restoreKey, filesRestoreKey: restoreKey }}
          >
            Open reader
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
          </Link>
        </Button>
      </div>
      {hasQueryClient ? (
        <ReportPreviewBody report={report} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
          Open reader to view this HTML report.
        </div>
      )}
    </section>
  )
}

function ReportPreviewBody({ report }: { report: Report }) {
  const artifact = useArtifact(report.runId, report.id)
  if (artifact.isPending) {
    return <p role="status" className="p-6 text-xs text-muted-foreground">Loading preview…</p>
  }
  if (artifact.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-6 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Could not load report preview</p>
        <p>{artifact.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => void artifact.refetch()}>Retry</Button>
      </div>
    )
  }
  const data = artifact.data
  if (!data || data.type !== 'file' || data.binary || data.content === undefined) {
    return <p className="p-6 text-xs text-muted-foreground">Preview unavailable for this artifact.</p>
  }
  return (
    <HtmlReportFrame
      html={data.content}
      title={reportTitle(report)}
      className="min-h-[420px] flex-1"
    />
  )
}

/** "Published · 37s" / "Published just now": the word says what a bare "37s" measures, and the
 *  age keeps the compact form every other list in the cockpit uses (no trailing "ago"). */
function publishedAge(createdAt: string): string {
  const age = shortAge(createdAt)
  if (!age) return ''
  return age === 'just now' ? 'Published just now' : `Published · ${age}`
}
