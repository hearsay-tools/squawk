import { productCommand } from '@/lib/product-name'
import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { useReports } from '@/api/reports'
import { REPORTS_QUERY_MAX } from '@open-mercato/cezar-api-client/contract/reports'
import { FileTextIcon } from 'lucide-react'
import { SearchIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { reportTitle } from '@/lib/report-title'
import { useSearchParamsWriter } from '@/lib/use-search-params-writer'
import './reports.css'

// Keep the source entry through both native Back and the reader's fallback navigation.
const positions = new Map<string, { scroll: number; row: string; pages: number }>()

/** Human-friendly short date/time for report cards (e.g. "Nov 26, 16:28"), never raw US locale strings. */
function formatReportTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
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
  return (
    <section data-route="reports" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-7 pb-4 [scrollbar-gutter:stable] md:px-9">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[26px] font-semibold tracking-tight leading-[1.2] text-foreground md:text-[28px]">Reports</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">Published HTML snapshots from tasks in this project.</p>
          </div>
        </header>
        <div className="relative w-full">
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
      </div>
      <div ref={scroller} data-slot="reports-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-9 [scrollbar-gutter:stable] md:px-9">
        {result.isPending ? (
          <p role="status" className="py-4 text-sm text-muted-foreground">Loading reports…</p>
        ) : result.isError ? (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5">
            <p className="text-sm font-medium text-foreground">Could not load reports</p>
            <p className="text-sm text-muted-foreground">{result.error.message}</p>
            <Button variant="outline" className="min-h-11" onClick={() => void result.refetch()}>Retry</Button>
          </div>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6">
            <h2 className="text-base font-semibold text-foreground">{q ? 'No matching reports' : 'No published reports yet'}</h2>
            {q ? (
              <Button data-slot="reports-clear-search" variant="outline" className="min-h-11" onClick={() => search('')}>Clear search</Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Publish an HTML snapshot with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{productCommand()} artifact publish</code> to list it here.
              </p>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {reports.map(report => (
              <li key={report.id} data-slot="report-row" className="reports-row flex flex-col gap-1.5 rounded-xl border border-border bg-card px-5 py-4 transition-colors">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <h2 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
                    <Link
                      data-report-id={report.id}
                      className="reports-open text-foreground no-underline"
                      to={`/tasks/${report.runId}/report?artifact=${report.id}`}
                      state={{ readerFrom: key, filesRestoreKey: key }}
                      onClick={() => positions.set(key, { scroll: scroller.current?.scrollTop ?? 0, row: report.id, pages: result.data?.pages.length ?? 1 })}
                    >
                      <FileTextIcon aria-hidden="true" className="mr-2 inline-block size-4 shrink-0 text-accent-text" />
                      <span>{reportTitle(report)}</span>
                    </Link>
                  </h2>
                  <time
                    className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground"
                    dateTime={report.createdAt}
                    title={report.createdAt}
                  >
                    {formatReportTimestamp(report.createdAt)}
                  </time>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <Link
                    className="reports-task text-xs text-muted-foreground no-underline hover:text-foreground hover:underline [overflow-wrap:anywhere]"
                    to={`/tasks/${report.runId}`}
                  >
                    {report.taskTitle}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
        {result.hasNextPage ? (
          <div className="mt-4">
            <Button variant="outline" className="min-h-11" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>
              Load more reports
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
