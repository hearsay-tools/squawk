import { productCommand } from '@/lib/product-name'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPORTS_QUERY_MAX } from '@open-mercato/cezar-api-client/contract/reports'
import { ReportsRoute } from './reports'

const mocks = vi.hoisted(() => ({ useReports: vi.fn() }))
vi.mock('@/api/reports', () => ({ useReports: mocks.useReports }))
const SAMPLE_CREATED_AT = '2026-11-01T12:00:00Z'
const refetch = vi.fn()
const result = (overrides = {}) => ({ isPending: false, isError: false, data: { pages: [{ reports: [], total: 0, nextCursor: null }] }, refetch, ...overrides })
function Location() { const l = useLocation(); return <div data-testid="location">{l.pathname + l.search}</div> }
function mount(path = '/p/shop/reports') {
  return render(<MemoryRouter initialEntries={[path]}><Location /><Routes><Route path="/p/:projectId/reports" element={<ReportsRoute />} /><Route path="/p/:projectId/tasks/:id/report" element={<Location />} /><Route path="/p/:projectId/tasks/:id" element={<p>Source conversation</p>} /></Routes></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Reports shelf', () => {
  it('explains loading, empty publication, and errors with Retry', () => {
    mocks.useReports.mockReturnValue(result({ isPending: true }))
    const view = mount()
    expect(screen.getByRole('status').textContent).toBe('Loading reports…')
    mocks.useReports.mockReturnValue(result()); view.rerender(<MemoryRouter><ReportsRoute /></MemoryRouter>)
    expect(screen.getByText('No published reports yet')).toBeTruthy()
    expect(screen.getByText(`${productCommand()} artifact publish`)).toBeTruthy()
    mocks.useReports.mockReturnValue(result({ isError: true, error: new Error('Storage unavailable') }))
    view.rerender(<MemoryRouter><ReportsRoute /></MemoryRouter>)
    expect(screen.getByRole('alert').textContent).toContain('Storage unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('reads search from the URL, writes composed query updates, and clears a search with no match', async () => {
    mocks.useReports.mockReturnValue(result())
    mount('/p/shop/reports?q=budget')
    expect((screen.getByRole('textbox', { name: 'Search reports' }) as HTMLInputElement).value).toBe('budget')
    expect(mocks.useReports).toHaveBeenLastCalledWith('budget')
    expect(screen.getByText('No matching reports')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'forecast' } })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('q=forecast'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/shop/reports'))
  })

  it('caps typed search and URL search at the shared contract maximum', async () => {
    mocks.useReports.mockReturnValue(result())
    mount('/p/shop/reports?q=' + 'a'.repeat(REPORTS_QUERY_MAX + 1))
    const input = screen.getByRole('textbox', { name: 'Search reports' }) as HTMLInputElement
    expect(input.maxLength).toBe(REPORTS_QUERY_MAX)
    expect(input.value).toBe('a'.repeat(REPORTS_QUERY_MAX))
    expect(mocks.useReports).toHaveBeenLastCalledWith('a'.repeat(REPORTS_QUERY_MAX))
    fireEvent.change(input, { target: { value: 'b'.repeat(REPORTS_QUERY_MAX + 1) } })
    await waitFor(() => expect(input.value).toBe('b'.repeat(REPORTS_QUERY_MAX)))
    expect(mocks.useReports).toHaveBeenLastCalledWith('b'.repeat(REPORTS_QUERY_MAX))
  })

  it('uses server titles and source-task links, and records the shelf as the reader source', async () => {
    mocks.useReports.mockReturnValue(result({ data: { pages: [{ reports: [{ id: 'abc', runId: 'source', title: 'Income', name: 'budget.html', taskTitle: 'Prepare budget', createdAt: SAMPLE_CREATED_AT }] }] } }))
    mount('/p/shop/reports?q=income')
    expect(screen.getByRole('link', { name: 'Prepare budget' }).getAttribute('href')).toBe('/p/shop/tasks/source')
    const report = screen.getByRole('link', { name: 'Income' })
    expect(report.getAttribute('href')).toBe('/p/shop/tasks/source/report?artifact=abc')
    const time = document.querySelector('[data-slot="report-row"] time')
    expect(time?.textContent).toMatch(/^Published (?:just now|· (?:\d+[smd]|\d+h(?: \d+m)?))$/)
    expect(time?.getAttribute('title')).toBeTruthy()
    expect(time?.getAttribute('title')).not.toBe(SAMPLE_CREATED_AT)
    fireEvent.click(report)
    await waitFor(() => expect(screen.getAllByTestId('location')[0]!.textContent).toContain('/tasks/source/report?artifact=abc'))
  })

  it('declares SplitPage template and sparse/empty/full density on the reports route', () => {
    mocks.useReports.mockReturnValue(result())
    const view = mount('/p/shop/reports')
    const shell = document.querySelector('[data-slot="page-shell"]')!
    expect(shell.getAttribute('data-template')).toBe('Split')
    expect(shell.getAttribute('data-density')).toBe('empty')

    mocks.useReports.mockReturnValue(result({
      data: {
        pages: [{
          reports: [{ id: 'r1', runId: 'source', title: 'Audit', name: 'audit.html', taskTitle: 'Audit task', createdAt: SAMPLE_CREATED_AT }],
          total: 1,
          nextCursor: null,
        }],
      },
    }))
    view.rerender(<MemoryRouter initialEntries={['/p/shop/reports']}><ReportsRoute /></MemoryRouter>)
    const updated = document.querySelector('[data-slot="page-shell"]')!
    expect(updated.getAttribute('data-density')).toBe('sparse')
    expect(document.querySelector('[data-slot="page-shell-sparse-footer"]')?.textContent).toContain('1 published report')
  })

  it('saves list position when opening the full reader from the preview pane', async () => {
    mocks.useReports.mockReturnValue(result({
      data: {
        pages: [{
          reports: [
            { id: 'r1', runId: 'source', title: 'Audit', name: 'audit.html', taskTitle: 'Audit task', createdAt: SAMPLE_CREATED_AT },
            { id: 'r2', runId: 'source-2', title: 'Summary', name: 'summary.html', taskTitle: 'Summary task', createdAt: SAMPLE_CREATED_AT },
          ],
          total: 2,
          nextCursor: null,
        }],
      },
    }))
    mount('/p/shop/reports')
    fireEvent.click(screen.getByRole('button', { name: 'Preview Summary' }))
    const openReader = document.querySelector<HTMLAnchorElement>('[data-slot="reports-preview-open"]')!
    expect(openReader.getAttribute('href')).toBe('/p/shop/tasks/source-2/report?artifact=r2')
    fireEvent.click(openReader)
    await waitFor(() => expect(screen.getAllByTestId('location')[0]!.textContent).toContain('/tasks/source-2/report?artifact=r2'))
  })

  it('omits the split preview pane when available content width cannot fit both panes', () => {
    let observerCallback: ResizeObserverCallback | null = null
    class StubResizeObserver {
      constructor(cb: ResizeObserverCallback) { observerCallback = cb }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 372, height: 600, top: 0, left: 0, bottom: 600, right: 372, x: 0, y: 0, toJSON: () => ({}),
    })
    try {
      mocks.useReports.mockReturnValue(result({
        data: {
          pages: [{
            reports: [{ id: 'r1', runId: 'source', title: 'Audit', name: 'audit.html', taskTitle: 'Audit task', createdAt: SAMPLE_CREATED_AT }],
            total: 1,
            nextCursor: null,
          }],
        },
      }))
      mount('/p/shop/reports')
      expect(document.querySelector('[data-slot="reports-preview-pane"]')).toBeNull()
      expect(document.querySelector('[data-slot="report-preview-select"]')).toBeNull()
      expect(document.querySelector('[data-slot="report-open-cue"]')).not.toBeNull()

      act(() => {
        observerCallback?.(
          [{ contentRect: { width: 720 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        )
      })
      expect(document.querySelector('[data-slot="reports-preview-pane"]')).not.toBeNull()
      expect(document.querySelector('[data-slot="reports-preview-open"]')).not.toBeNull()
      expect(document.querySelector('[data-slot="report-open-cue"]')).toBeNull()
    } finally {
      rectSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
