import { defined } from '@open-mercato/cezar-api-client/contract/defined'
import { invalidateLiveReads } from './live-coordinator'
import type { WorkerDestroyWork, OkJson } from '@open-mercato/cezar-api-client'
import {
  API_PREFIX,
  apiPath,
  getApiBaseUrl,
  getApiScope,
} from '@open-mercato/cezar-api-client/utils/project-scope'
import { createSquawkClient } from '@open-mercato/cezar-api-client/client'
import type { ClientResponse } from 'hono/client'
import type { ResponseFormat } from 'hono/types'
import type { AppType } from '@wjarka/cezarion/app-type'

/**
 * The cockpit's client transport for its own HTTP API.
 *
 * Same-origin by construction: the Hono server serves this bundle and owns `/api/v1/*`, and the
 * Vite dev server proxies `/api` to it. So every URL here is root-relative — there is no base
 * URL to configure and no cross-origin case to get wrong.
 *
 * Calls name a ROUTE (`/runs/:id/diff`), never a URL: `apiPath` (api-client) adds the version
 * and, when a project scope is active, the `/p/<id>` segment. That is why the version appears
 * once in this repo rather than at every call site. `runFileRawUrl` is the one URL this module
 * hands out instead of fetching itself, so it resolves the route at build time.
 *
 * This module is the boundary. It parses responses, turns every non-2xx into an `ApiError`
 * carrying the server's own words, and does nothing else: no caching, no retries, no
 * reconnect. Freshness is SSE's job and TanStack Query's (queries.ts, and Step 3.2's reconcile).
 *
 * Every call goes through the typed client (`cez`/`unwrap` below), which checks the route against
 * the server's own handlers. Three functions keep their own `fetch` for a reason `hc` cannot
 * express, and each says which in its own comment: `registerProject` (a 409 is a SUCCESS for the
 * add-project flow), `requestText` (the routes that answer `text/plain`), and `runFileRawUrl`
 * (a URL handed to an `<img>`, never fetched). All of them end in the same `ApiError` contract,
 * so a caller cannot tell which path a given function uses.
 */

/**
 * A failed API call.
 *
 * `message` is the server's `{ error }` verbatim wherever it sent one, because it writes those
 * for the person reading them — "run is active — cancel it first", "no terminal emulator
 * found". Rewording them here would be inventing a worse error. The extras are the fields the
 * server pairs with specific 409s so the UI can offer the manual way out.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server (offline, server stopped). */
  readonly status: number
  /** `POST /api/runs/:id/pr`: the `git merge <branch>` to run by hand when the PR failed. */
  readonly manual?: string | undefined
  /** `POST /api/runs/:id/open-in-cli`: the resume command, when no terminal could be opened. */
  readonly command?: string | undefined
  /** `POST /api/workflows`: the file is already there — the caller may retry with `overwrite`. */
  readonly exists?: boolean | undefined
  /** `POST /runs/:id/worker-destroy`: the work the cleanup refused to delete; a retry with
   *  `discardWork` deletes it (hearsay-tools/squawk#3553). */
  readonly work?: WorkerDestroyWork | undefined

  constructor(
    status: number,
    message: string,
    extras: { manual?: string | undefined; command?: string | undefined; exists?: boolean | undefined; work?: WorkerDestroyWork | undefined; cause?: unknown } = {},
  ) {
    super(message, extras.cause !== undefined ? { cause: extras.cause } : undefined)
    this.name = 'ApiError'
    this.status = status
    this.manual = extras.manual
    this.command = extras.command
    this.exists = extras.exists
    this.work = extras.work
  }
}

export type ReadOptions = {
  /** Wired to TanStack Query's per-query signal, so an unmounted view stops its fetch. */
  signal?: AbortSignal | undefined
  /** Read another project than the active one — only for the functions that say so (the
   *  project-switch existence checks); everything else follows `queryScope()`. */
  projectId?: string | undefined
}

type Json = Record<string, unknown>

/** JSON.parse that answers "not JSON" instead of throwing — an error body is untrusted input:
 *  a proxy's HTML 502 page is as likely as the server's own `{ error }`. */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function destroyWork(value: unknown): WorkerDestroyWork | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { uncommittedFiles, commits } = value as Json
  return typeof uncommittedFiles === 'number' && typeof commits === 'number' ? { uncommittedFiles, commits } : undefined
}

/** Build the ApiError for a non-2xx, preferring the server's own message. */
export function errorFor(status: number, statusText: string, body: string): ApiError {
  const parsed = parseJson(body)
  const json: Json = parsed && typeof parsed === 'object' ? (parsed as Json) : {}
  const message =
    str(json.error) ??
    // No `{ error }` — a proxy error page, an empty body, a crash. Say what we know rather
    // than leak a page of HTML into a toast.
    `${status} ${statusText || 'request failed'}`.trim()
  return new ApiError(status, message, {
    manual: str(json.manual),
    command: str(json.command),
    exists: typeof json.exists === 'boolean' ? json.exists : undefined,
    work: destroyWork(json.work),
  })
}

/**
 * The typed client over the same service (`@open-mercato/cezar-api-client`).
 *
 * Routes are being moved onto this one at a time. What it buys is compile-time checking of the
 * path, the request body and the response shape against the server's OWN handlers — the thing
 * the hand-written DTOs in this package approximate by hand and can drift from.
 *
 * It does NOT replace this module. `client.ts` stays the boundary: it owns `ApiError` (with the
 * server's own words), the credentials policy, and the non-JSON-body case. The typed client
 * only builds and sends the request; `unwrap` applies the same answer contract to whatever
 * comes back, so a migrated call behaves identically to a hand-written one.
 *
 * Not every route is ready. A handler that returns a loose type (`/health` answers
 * `Record<string, unknown>`) infers a weaker response than the DTO it replaces, so those wait
 * until the server tightens its own return types.
 */
export const cez = createSquawkClient<AppType>({
  // The base URL is resolved per request, not baked in at construction: this module is imported
  // before `main.tsx` configures it, and a `<meta>`-configured deployment must still take
  // effect. `hc` builds a root-relative URL, so prefixing here is the whole job.
  fetch: (input: string | URL | Request, init?: RequestInit) =>
    fetchOrThrow(withApiBase(String(input)), init),
})

/**
 * Prefix a root-relative URL the typed client built with the configured service origin.
 *
 * Also the one place the two request paths are reconciled on the wire. `hc` appends a `?` for
 * any `query` argument it is given, even one whose every value was optional and absent — an
 * equivalent URL, but not the one `apiPath` writes, and the stubs in this app's tests match on
 * the path they see.
 */
function withApiBase(url: string): string {
  const path = unscoped(url.endsWith('?') ? url.slice(0, -1) : url)
  return path.startsWith('/') ? `${getApiBaseUrl()}${path}` : path
}

/** The scoped spelling `hc` always builds for a project-scoped route, with no project mounted. */
const DEFAULT_SCOPE = `${API_PREFIX}/p/default`

/**
 * Drop the `/p/default` segment when no project scope is active.
 *
 * `hc` paths are static: a project-scoped route is spelled `p[':projectId']` at every call site
 * and the active scope goes in as `queryScope()`, which answers `'default'` when there is none.
 * That keeps ONE code path per call (the alternative was a branch per call), and the server
 * reserves `default` as the alias for the boot project, so both spellings reach the same handler.
 *
 * They are not the same URL, though, and this module's other half (`apiPath`) emits the
 * unprefixed one when unscoped. Normalising here — the single point every typed-client request
 * passes through — is what keeps an unscoped request byte-identical whichever half sent it, so
 * migrating a route never moves it on the wire.
 */
function unscoped(url: string): string {
  if (getApiScope() !== null || !url.startsWith(DEFAULT_SCOPE)) return url
  const rest = url.slice(DEFAULT_SCOPE.length)
  // Only a whole segment: a project genuinely called `default-ish` must keep its own prefix.
  return rest === '' || rest.startsWith('/') || rest.startsWith('?') ? `${API_PREFIX}${rest}` : url
}

/** The per-request options `hc` takes, from this module's `ReadOptions`. */
export const init = (opts?: ReadOptions) => ({ init: { ...defined({ signal: opts?.signal }) } })

/**
 * Accepts a route that answers more than one FORMAT — `/repo/commit/:sha` serves a structured
 * payload or a raw blob on the same path, `/runs/:id/files` a listing or image bytes — and reads
 * the JSON branch. `OkJson` keeps that from becoming a hole: a route with no JSON branch at all
 * resolves to a branded error type rather than to `never`, which would have been assignable to
 * every caller's declared return type and failed only at runtime.
 */
export async function unwrap<R extends ClientResponse<unknown, number, ResponseFormat>>(
  res: R,
  label: string,
): Promise<OkJson<R>> {
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  const parsed = parseJson(body)
  if (parsed === undefined) {
    throw new ApiError(res.status, `the Squawk server answered ${label} with a non-JSON body`)
  }
  return parsed as OkJson<R>
}

/**
 * The `safeParse` half of a contract schema, spelled structurally.
 *
 * Keeps this package free of a direct `zod` dependency: the schemas arrive through the
 * api-client barrel as runtime values (`contract-pipeline.test.ts` pins that), and this is the
 * only part of them `unwrapValidated` uses.
 */
type ResponseValidator<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

/**
 * `unwrap`, plus the shape check its cast cannot make.
 *
 * `unwrap` ends in `parsed as OkJson<R>` — a compile-time claim about a body the server sent at
 * runtime. For most routes the claim is harmless: a caller reading a missing field gets
 * `undefined` and renders nothing. The history routes are different — `useRunHistory` iterates
 * `page.events`, so a 200 whose body is not a page throws a `TypeError` mid-render and takes the
 * session view down with it, bypassing the hook's own full-replay fallback (which only triggers
 * on a REJECTED query). Validating here turns that body into the same `ApiError` a non-JSON body
 * already produces, so the malformed case degrades exactly like the unreachable one.
 *
 * Its own server cannot produce such a body (`contract-parity.test.ts` pins both response types
 * to these schemas) — this guards the boundary against a proxy, a stale server, or a stub.
 */
export async function unwrapValidated<R extends ClientResponse<unknown, number, ResponseFormat>>(
  res: R,
  label: string,
  schema: ResponseValidator<OkJson<R>>,
): Promise<OkJson<R>> {
  const status = res.status
  const parsed = await unwrap(res, label)
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new ApiError(status, `the Squawk server answered ${label} with an unexpected body`)
  }
  return result.data
}

/**
 * Shared fetch boundary for typed and hand-written requests. Include browser credentials,
 * convert unreachable transport failures to status-0 ApiError, and rethrow caller aborts
 * unchanged.
 */
async function fetchOrThrow(url: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, credentials: 'include' })
    if (response.ok && init?.method && !['GET', 'HEAD'].includes(init.method.toUpperCase())) invalidateLiveReads()
    return response
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the Squawk server (${url})`, { cause })
  }
}

export async function send(path: string, init: RequestInit): Promise<Response> {
  // Resolved here so the error names the URL that actually failed, not the route the caller
  // asked for — "cannot reach /health" would send someone looking for the wrong thing.
  return fetchOrThrow(apiPath(path), init)
}

/**
 * For the endpoints that answer `text/plain` (diffs, the handoff journal).
 *
 * These say so in `Accept`. Two of the server's routes now negotiate the representation from that
 * header when no query flag decides it (`/repo/commit/:sha`, `/runs/:id/files`), and a reader that
 * wants text should ASK for text rather than rely on a default — `fetch` would otherwise send
 * `*<slash>*`, which those routes deliberately read as "no preference". None of the callers here
 * is on a negotiating route today; the header is what keeps that true if one ever moves.
 */
export async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'text/plain')
  const res = await send(path, { ...init, headers })
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  return body
}

export const runPath = (id: string, suffix = ''): string => `/runs/${encodeURIComponent(id)}${suffix}`
