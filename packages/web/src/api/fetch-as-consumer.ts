import { QueryObserver, type QueryClient, type QueryFunction, type QueryKey } from '@tanstack/react-query'

/**
 * Reads a shared cache entry as one of its consumers. A shared request lives exactly as long
 * as it has a consumer: this read, a mounted query, or another read that joins it.
 *
 * The request fetches with the query's own signal, never with `signal`. While the read waits,
 * a disabled observer counts it as a consumer, so another consumer that leaves cannot cancel
 * the request under it. When `signal` aborts, the read stops being a consumer; if it was the
 * last one, TanStack cancels the request and aborts its fetch.
 */
export async function fetchAsConsumer<T>(client: QueryClient, options: { queryKey: QueryKey; queryFn: QueryFunction<T>; staleTime?: number }, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const consumer = new QueryObserver<T>(client, { queryKey: options.queryKey, queryFn: options.queryFn, retry: false, enabled: false })
  const release = consumer.subscribe(() => undefined)
  signal.addEventListener('abort', release, { once: true })
  try {
    return await client.fetchQuery({ ...options, retry: false })
  } finally {
    signal.removeEventListener('abort', release)
    release()
  }
}
