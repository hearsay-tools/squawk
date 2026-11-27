# Orchestrator MCP server
Status: draft

Issues: hearsay-tools/squawk#4401 (Slice 1, stdio `hsq mcp`) and hearsay-tools/squawk#4402 (Slice 2, Streamable HTTP `/api/v1/mcp` with bearer tokens).
Baseline: `main` at `ba0c3f735` (2026-11-27). Paths are under `packages/cezar/` unless noted.

## Goal

Give an outside orchestrator agent (such as Darkhorse driving a fleet of coding hosts) an MCP (Model Context Protocol) server over Squawk's existing task operations. Ship it in two slices sharing one tool core on `@modelcontextprotocol/sdk` (`^1.30.0`, already a dependency in `packages/cezar/package.json`):

1. **Slice 1 (hearsay-tools/squawk#4401): stdio `hsq mcp`** as a bundled feature plugin under `src/features/mcp/`, working locally and over SSH with zero configuration.
2. **Slice 2 (hearsay-tools/squawk#4402): stateless Streamable HTTP `/api/v1/mcp`** inside the cockpit server, protected by host-managed bearer tokens for multi-host fleets.

Both slices reuse the operations, projections, attention rules, and wait semantics already proven in `src/task-cli/`.

## Out of scope

- Publishing `@open-mercato/cezar-api-client` (deferred until plugin package installation starts; MCP tools describe themselves at run time and ship with the server binary).
- Host-only and webhook-only CLI commands (`open`, `notify`, `unarchive`, `archive-finished`): remain CLI-only.
- Browser UI for creating or viewing MCP bearer tokens: token management stays host-CLI-only per [ADR 0055](../../docs/adr/0055-grant-remote-settings-administration-from-the-host.md).
- Opening non-MCP `/api/v1/*` routes to bearer tokens: bearer authentication authorizes `/api/v1/mcp` only.
- Event-driven `store.lifecycle` wakeup inside `task_wait`: follow-up optimization if 1.5 s in-process summary polling becomes noticeable.
- One-view multi-host cockpit UI: separate topic outside this spec.

## Done when

- **Outcome:** Both hearsay-tools/squawk#4401 and hearsay-tools/squawk#4402 are closed, an orchestrator can discover projects and drive tasks over stdio (`hsq mcp`) or Streamable HTTP (`/api/v1/mcp` with a bearer token), and this spec is `Status: done`.
- **Proof:** `StdioClientTransport` and `StreamableHTTPClientTransport` integration tests complete `project_list`, `task_start`, `task_wait`, `task_status`, `task_send`, `task_stop`, and `task_list` against a `CEZ_DRY_RUN=1` cockpit; the HTTP auth test matrix proves fail-closed `404`/`401`/`403`, live revocation, project-scoped token isolation, and stateless survival across a cockpit restart; `ubuntu-vps` nginx tests confirm `auth_basic off;` on `location = /api/v1/mcp`; `hsq plugins` lists `mcp` as `bundled`, and booting without `src/features/mcp/` succeeds.
- **Failure:** Any `task_*` call omitting `project` or naming an unknown project fails; `hsq mcp` refuses to start when `HSQ_TASK_ID` (`CEZ_TASK_ID`) is set; `/api/v1/mcp` returns `404` with no token configured, `401` with `WWW-Authenticate: Bearer` on missing/bad/Basic auth, and `403` when `Origin` is present; `HSQ_MCP_TOKEN` never appears in child agent environments even under `HSQ_AGENT_ENV_FULL=1`.

## Decisions

1. **Reuse `hsq task` 1-to-1 instead of inventing a parallel API.** Extract typed operation functions from `src/task-cli/cli.ts` returning JSON data objects (not writing `stdout` or exit codes) and inject a `fetch` transport in `src/task-cli/http.ts`. Both `hsq task` and MCP call the same functions.
2. **One transport seam removes a second backend.** Slice 1 (`hsq mcp` stdio) passes normal `fetch` against loopback (`http://127.0.0.1:<port>/api/v1/p/:projectId/...`). Slice 2 (`/api/v1/mcp` HTTP) passes an in-process adapter around Hono's `app.fetch(req)` (synthetic loopback `Host`, no `Origin`), reusing every `runs-routes.ts` invariant with zero TCP hop.
3. **Require `project` on every `task_*` tool; add `project_list` for discovery.** Never fall back to `bootProject`, and never scan projects to guess which repository owns a task ID. The boot project is an accidental startup detail; silently starting an agent in the wrong repository over HTTP is a bug. Keep the exact same required-`project` schema on stdio and HTTP so orchestrators use identical calls across local trials, SSH, and fleet HTTP.
4. **Expose `project_list` as an MCP tool (not only a resource).** Many orchestrators wire MCP tools only, and `initialize` text goes stale as projects change. `project_list` reads `GET /api/v1/projects` and projects only `{ id, name, status, branch?, repoUrl?, tags? }`, stripping `root`, `projectsDir`, `bootProject`, and `webhooks`.
5. **Stateless Streamable HTTP with SSE keep-alive.** Use `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and `keepAliveMs: 15_000`. Fleet hosts restart on deploy; stateless calls avoid stale `Mcp-Session-Id` 404s while SSE keep-alives and `c.req.raw.signal` keep `task_wait` proxy-safe and cleanly abortable.
6. **Host-CLI per-port hashed bearer tokens (ADR 0055 pattern) plus optional `HSQ_MCP_TOKEN`.** Store SHA-256 digests per listen port under `<config>/mcp-tokens/<port>.json` (mode `0600` via `HomeStore`), checked per request with `crypto.timingSafeEqual` so create/revoke takes effect with no restart and multi-domain installs stay isolated. Support `HSQ_MCP_TOKEN` for container/systemd deploys, stripped from child agent environments and redacted from logs.

## Tool surface

MCP server name: `squawk`. Server `initialize` `instructions` tell the caller to run `project_list` first, pass `project` to every `task_*` tool, and read `attention`/`attentionLabel` (from `deriveAttention`) to know when a task needs input.

| Tool | Underlying operation | Inputs | Output |
| --- | --- | --- | --- |
| `project_list` | `GET /api/v1/projects` | none | `{ projects: [{ id, name, status, branch?, repoUrl?, tags? }] }` |
| `task_start` | `hsq task start` (`POST /runs`) | `project` (req), `task` (req, 1–100k chars), `requestId?`, `workflow?`, `skill?`, `runner?`, `model?`, `effort?`, `autonomous?`, `worktree?`, `allowWorkers?`, `allowMessaging?`, `archiveWhenDone?`, `autoMergePr?` | `{ id, project, status, created, requestId, branch, url, warning? }` |
| `task_send` | `hsq task send` (`POST /messages`, optional `POST /continue`) | `project` (req), `id` (req), `text` (req), `resume?` (default `false`) | `{ id, project, delivery: 'delivered' \| 'queued' \| 'deferred' \| 'resumed' \| 'not-delivered', reason?, hint? }` |
| `task_status` | `hsq task status` (`GET /runs/:id`, `history-context`, optional `handoff`) | `project` (req), `id` (req), `full?`, `includeHandoff?`, `maxChars?` | Slim `projectStatus` + pending `question`/`questionContext` + optional bounded `handoff` text |
| `task_log` | `hsq task log` (snapshot only, no `--follow`) | `project` (req), `id` (req), `since?` (default `0`), `maxChars?` (default `8000`) | `{ id, project, events: [...], lastSeq, truncated }` |
| `task_diff` | `hsq task diff` (`GET /changes` or `GET /diff`) | `project` (req), `id` (req), `stat?`, `maxChars?` | Stat summary or bounded patch `{ id, project, diff, truncated }` |
| `task_wait` | `hsq task wait` (`waitForRuns`) | `project` (req), `ids` (req, 1–32), `mode?` (`'any' \| 'all'`, default `'any'`), `until?` (`'attention' \| 'settled'`, default `'attention'`), `timeoutSeconds?` (`1`–`1800`, default `120`) | `{ project, until, mode, timedOut, runs: [...] }` (emits 15 s `notifications/progress` heartbeats when `_meta.progressToken` is set; honours `AbortSignal`) |
| `task_stop` | `hsq task stop` (`POST /cancel`) | `project` (req), `id` (req) | `{ id, project, cancelled }` |
| `task_finish` | `hsq task finish` (`POST /finish`) | `project` (req), `id` (req) | `{ id, project, finished: true }` |
| `task_archive` | `hsq task archive` (`POST /archive`) | `project` (req), `id` (req) | `{ id, project, archived: true }` |
| `task_list` | `hsq task list` (`GET /run-summaries` or `GET /workspace/runs-index` when `project === 'all'`) | `project` (req, project id or `'all'`), `status?`, `limit?` (1–200, default `20`), `all?`, `full?` | `{ project, total, runs: [...] }` (workers excluded) |

Tool refusals (`404`, `409`, `400`, unavailable cockpit) return MCP `isError: true` with structured JSON `{ code, error, hint? }`.

## Evidence

- Existing task client: `src/task-cli/cli.ts`, `src/task-cli/http.ts`, `src/task-cli/discovery.ts`, `src/task-cli/projections.ts`, `src/task-cli/watch.ts`.
- Existing MCP dependency and stdio precedent: `@modelcontextprotocol/sdk` `^1.30.0` (`StdioServerTransport` in `src/ci-wait/mcp.ts`, `WebStandardStreamableHTTPServerTransport` shipped in `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`).
- Bundled feature plugin precedent and isolation lint rule: `src/features/jobs/index.ts`, [ADR 0072](../../docs/adr/0072-add-a-launch-slot-and-load-bundled-feature-plugins.md), `src/lint/bundled-feature-import.ts`.
- Project registry contract: `packages/contract/src/projects.ts` (`projectListEntrySchema` already computes sanitized `repoUrl`, `branch`, `tags`, `status`).
- Security and proxy precedents: [ADR 0046](../../docs/adr/0046-guard-local-http-and-websocket-authority.md) (`server/server.ts`), [ADR 0055](../../docs/adr/0055-grant-remote-settings-administration-from-the-host.md) (`src/remote-settings.ts`), `src/server/static-ui.ts` (`/api/*` already bypasses SPA fallback), `src/server-install/platforms/ubuntu-vps.ts` (nginx `auth_basic` sits on `server {}`, so `/api/v1/mcp` needs `location = /api/v1/mcp { auth_basic off; }`).

## Plan

### Slice 1 — Stdio `hsq mcp` (hearsay-tools/squawk#4401)

1. Extract pure operation functions from `src/task-cli/cli.ts` (`src/task-cli/operations.ts`) and add an optional `fetch` + `signal` parameter to `src/task-cli/http.ts` and `waitForRuns` in `src/task-cli/watch.ts`. Keep `hsq task` behavior and tests unchanged.
2. Add `src/features/mcp/` (layer `feature:mcp` in `src/lint/layers.json`):
   - `tools.ts`: register `project_list` and the 10 `task_*` tools on MCP `Server`, enforcing required `project`, bounded outputs, structured `isError` responses, and `task_wait` abort + 15 s progress heartbeats.
   - `stdio.ts` + `cli.ts`: `hsq mcp [--url <origin>] [--repo <dir>]`, cockpit discovery (repo match, or single running local cockpit when launched from `$HOME` over SSH), strict stdout hygiene, `HSQ_TASK_ID`/`CEZ_TASK_ID` refusal, clean shutdown on stdin EOF/signals.
   - `index.ts`: bundled `SquawkPlugin` registering `mcp` via `api.registerCliCommand`.
3. Add unit tests, a real `StdioClientTransport` integration test against a `CEZ_DRY_RUN=1` cockpit, and an absent-feature boot test. Update `docs/areas/cli.md` and `src/pack-check.ts` if needed.

### Slice 2 — Streamable HTTP `/api/v1/mcp` with bearer tokens (hearsay-tools/squawk#4402)

1. Add per-port hashed bearer token storage (`<config>/mcp-tokens/<port>.json`, `0600`, `HomeStore`, SHA-256 + `crypto.timingSafeEqual`, optional `project` scope) and `hsq mcp token create|list|revoke` subcommands. Add `HSQ_MCP_TOKEN` to `.env.example`, strip it from child agent environments in `src/core/product-env.ts`, and register active values with `src/core/secret-redaction.ts`. Clean up port token files in `server-uninstall`.
2. Wire the HTTP endpoint at `POST /api/v1/mcp` using `WebStandardStreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, `keepAliveMs: 15_000`) and an in-process `app.fetch` adapter calling the Slice 1 tool core. Respect `cez/bundled-feature-import`: either add a minimal non-RPC `registerHttpRoute` slot on `SquawkPluginApi` (plugin roadmap step 5) so `features/mcp/index.ts` registers `/api/v1/mcp` directly, or keep the shared tool core under `src/mcp/` (outside `src/features/`) until step 5's route-slot epic lands.
3. Gate `/api/v1/mcp`: `404` when no token is configured, `401` + `WWW-Authenticate: Bearer` on invalid/missing/Basic auth, `403` when `Origin` is present, loopback `Host` check in local mode, 1 MiB body limit, and project-scope enforcement when a token pins `--project`.
4. Add `location = /api/v1/mcp` (`auth_basic off;`, `proxy_buffering off;`, `proxy_read_timeout 3600s;`) to `src/server-install/platforms/ubuntu-vps.ts` and document TLS/proxy setup in `docs/remote-access.md` and `docs/areas/http-api.md`.
5. Add auth matrix tests, `StreamableHTTPClientTransport` lifecycle + restart tests, child-env stripping/redaction tests, and nginx vhost tests.

## Case tables

No required case table from [TEMPLATE.md](TEMPLATE.md#case-tables) applies: this feature adds no run state, run exit trigger, hold/resume transition, cross-run relationship, lock or claim, `ToolGrant` mapping, worktree mutation, detached background process, removed rule text, or saved client state restore. Every task mutation routes through the existing HTTP run endpoints (`POST /runs`, `/messages`, `/continue`, `/cancel`, `/finish`, `/archive`), which retain their existing state and ownership checks.
