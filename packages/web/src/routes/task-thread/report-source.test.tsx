import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getArtifactMetadata, getRunRelationships } from '@/api/client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { useReportSource } from './report-source'

vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(), getArtifactMetadata: vi.fn(), getRunRelationships: vi.fn() }))
const metadata = vi.mocked(getArtifactMetadata)
const relationships = vi.mocked(getRunRelationships)
const missing = () => new ApiError(404, 'Artifact not found')
afterEach(() => { cleanup(); vi.resetAllMocks() })

function lookup(artifactId: string | undefined = 'report') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useReportSource('parent', artifactId), { wrapper })
}

describe('report source without mounted cards or transcript data', () => {
  it('finds a same-run publication with no card', async () => {
    metadata.mockResolvedValue({ artifact: { id: 'report' } } as Awaited<ReturnType<typeof getArtifactMetadata>>)
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.data).toBe('parent'))
    expect(metadata.mock.calls.map(call => call.slice(0, 2))).toEqual([['parent', 'report']])
    expect(relationships).not.toHaveBeenCalled()
  })

  it('finds a worker publication with no card', async () => {
    metadata.mockImplementation(async runId => {
      if (runId === 'worker') return { artifact: { id: 'report' } } as Awaited<ReturnType<typeof getArtifactMetadata>>
      throw missing()
    })
    relationships.mockResolvedValue({ workers: [{ workerId: 'empty' }, { workerId: 'worker' }] } as Awaited<ReturnType<typeof getRunRelationships>>)
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.data).toBe('worker'))
    expect(metadata.mock.calls.map(call => call[0])).toEqual(['parent', 'empty', 'worker'])
    expect(relationships).toHaveBeenCalledWith('parent', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('ends an unknown artifact with the reader missing error', async () => {
    metadata.mockRejectedValue(missing())
    relationships.mockResolvedValue({ workers: [{ workerId: 'worker' }] } as Awaited<ReturnType<typeof getRunRelationships>>)
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
    expect(hook.result.current.error).toMatchObject({ status: 404, message: 'Report missing or deleted' })
    expect(hook.result.current.isPending).toBe(false)
  })

  it('keeps lookup loading while metadata is pending', () => {
    metadata.mockImplementation(() => new Promise(() => {}))
    const hook = lookup()
    expect(hook.result.current.isPending).toBe(true)
    expect(hook.result.current.data).toBeUndefined()
  })

  it('preserves a transport error instead of calling a report missing', async () => {
    metadata.mockRejectedValue(new ApiError(500, 'Storage unavailable'))
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.error).toMatchObject({ status: 500 }))
    expect(relationships).not.toHaveBeenCalled()
  })

  it('does not probe anything without an open report', () => {
    // renderHook has no ReportCard or transcript provider in any case.
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    renderHook(() => useReportSource('parent', undefined), { wrapper })
    expect(metadata).not.toHaveBeenCalled()
    expect(relationships).not.toHaveBeenCalled()
  })
})

describe('report source sharing a metadata request', () => {
  type Metadata = Awaited<ReturnType<typeof getArtifactMetadata>>
  // Like fetch: an aborted signal rejects the request; otherwise the test answers it.
  function pendingMetadata() {
    const answers: Array<() => void> = []
    metadata.mockImplementation((_runId, _artifactId, opts) => new Promise<Metadata>((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason))
      answers.push(() => resolve({ artifact: { id: 'report' } } as Metadata))
    }))
    return { answerAll: () => { for (const answer of answers.splice(0)) answer() } }
  }
  const wrapperFor = (client: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

  it('resolves after a source card registers while the metadata request is in flight', async () => {
    const pending = pendingMetadata()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(({ known }: { known: string | undefined }) => useReportSource('parent', 'report', known), { wrapper: wrapperFor(client), initialProps: { known: undefined as string | undefined } })
    await waitFor(() => expect(metadata).toHaveBeenCalledTimes(1))
    // The registered card changes the lookup key; the first lookup is cancelled mid-request.
    hook.rerender({ known: 'parent' })
    await act(async () => { pending.answerAll() })
    await waitFor(() => expect(hook.result.current.isPending).toBe(false))
    expect(hook.result.current.error).toBeNull()
    expect(hook.result.current.data).toBe('parent')
  })

  it('resolves when a source card joins and leaves the metadata request of the lookup', async () => {
    const pending = pendingMetadata()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The card's own metadata read, as a virtualized row mounts and then leaves the viewport.
    function Card() {
      useQuery({ queryKey: [queryScope(), 'runs', 'artifact-metadata', 'parent', 'report'], queryFn: ({ signal }) => getArtifactMetadata('parent', 'report', { signal }) })
      return null
    }
    let lookup: ReturnType<typeof useReportSource> | undefined
    function Pane() {
      lookup = useReportSource('parent', 'report')
      return null
    }
    const tree = (card: boolean) => <QueryClientProvider client={client}>{card ? <Card key="card" /> : null}<Pane key="pane" /></QueryClientProvider>
    const view = render(tree(false))
    await waitFor(() => expect(metadata).toHaveBeenCalledTimes(1))
    view.rerender(tree(true))
    view.rerender(tree(false))
    await act(async () => { pending.answerAll() })
    await waitFor(() => expect(lookup?.isPending).toBe(false))
    expect(lookup?.error).toBeNull()
    expect(lookup?.data).toBe('parent')
    expect(metadata).toHaveBeenCalledTimes(1)
    expect(metadata.mock.calls[0]?.[2]?.signal?.aborted).toBe(false)
  })

  it('aborts the metadata request when the lookup was its last consumer', async () => {
    pendingMetadata()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(() => useReportSource('parent', 'report'), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(metadata).toHaveBeenCalledTimes(1))
    hook.unmount()
    expect(metadata.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
  })

  it('aborts the relationships request when the lookup was its last consumer', async () => {
    metadata.mockRejectedValue(missing())
    relationships.mockImplementation((_runId, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason))
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(() => useReportSource('parent', 'report'), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(relationships).toHaveBeenCalledTimes(1))
    hook.unmount()
    expect(relationships.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
