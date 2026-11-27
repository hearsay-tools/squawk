import { productIdentity } from '../home/identity.ts';
import { productEnv } from '../core/product-env.ts';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { capabilitiesSchema, healthResponseSchema, pluginsHealthSchema } from '@open-mercato/cezar-contract/health';

/** Health from any cockpit version: a running cockpit can predate capabilities and the plugin report
 *  added since its build, and discovery reads none of them. Same tolerance as the cockpit's
 *  `healthPayloadSchema`. */
const cockpitHealthSchema = healthResponseSchema.extend({ capabilities: capabilitiesSchema.partial(), plugins: pluginsHealthSchema.optional() });
import { projectsResponseSchema } from '@open-mercato/cezar-contract/projects';
import { cockpitForProject, fetchJson, TaskCliError, type Cockpit, type FetchFn } from './http.ts';
import { runGit } from '../git-command.ts';

/**
 * Which cockpit serves this checkout (#504, spec 2026-09-24-cez-task-cli). Zero config: probe the
 * historical auto-port range (also covering deliberately selected ports) and match the
 * registry's project roots against this repo. Never starts a server and never writes anything
 * — a missing cockpit is an answer, not a fallback.
 */

/** Retain discovery of older auto-port cockpits and explicitly selected nearby ports. */
export const COCKPIT_PORTS: readonly number[] = Array.from({ length: 50 }, (_, index) => 4321 + index);
const PROBE_TIMEOUT_MS = 1_500;

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  return runGit(['-C', cwd, ...args], { timeout: 5_000, ...(signal ? { signal } : {}) }).then(({ stdout }) => stdout.trim(), () => undefined);
}

async function realpathOr(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}

/**
 * The main checkout that owns `dir`. A task worktree's common git dir is the parent repo's
 * `.git`, so this is what maps `.ai/cezar/worktrees/<id>` back to the project that ran it.
 * Submodules instead keep their git dir under `.git/modules/` and record `core.worktree`.
 */
export async function checkoutRoot(dir: string, signal?: AbortSignal): Promise<string> {
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal);
  if (common && basename(common) === '.git') return realpathOr(dirname(common));
  if (common) {
    // Read the main worktree's config, not a linked worktree override. Git resolves a relative
    // core.worktree against this shared git dir, even when the caller is in a task worktree.
    const main = await git(dir, ['--git-dir', common, 'config', '--path', '--get', 'core.worktree'], signal);
    if (main) return realpathOr(resolve(common, main));
  }
  const top = await git(dir, ['rev-parse', '--show-toplevel'], signal);
  return realpathOr(top ?? dir);
}

interface Candidate { origin: string; projects: Array<{ id: string; root: string }>; bootProject: string }

/** Health first (cheap, and it proves this is a Squawk), then the registry with its roots. */
async function probe(origin: string, timeoutMs: number, signal?: AbortSignal, fetchImpl?: FetchFn): Promise<Candidate | undefined> {
  try {
    const health = await fetchJson(`${origin}/api/v1/health`, { timeoutMs, ...(signal ? { signal } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    if (health.status !== 200 || !cockpitHealthSchema.safeParse(health.data).success) return undefined;
    const registry = await fetchJson(`${origin}/api/v1/projects`, { timeoutMs, ...(signal ? { signal } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    const parsed = projectsResponseSchema.safeParse(registry.data);
    if (registry.status !== 200 || !parsed.success) return undefined;
    const projects = await Promise.all(parsed.data.projects.map(async (entry) => ({ id: entry.id, root: await realpathOr(entry.root) })));
    return { origin, projects, bootProject: parsed.data.bootProject };
  } catch {
    return undefined;
  }
}

export interface DiscoverOptions {
  /** `--url` / `CEZ_URL`: skip the probe. */
  url?: string | undefined;
  repoDir: string;
  ports?: readonly number[];
  timeoutMs?: number;
  /** Abandons discovery: in-flight probes and git children end, and the call rejects. */
  signal?: AbortSignal;
  fetch?: FetchFn | undefined;
}

function parseCockpitOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new TaskCliError(64, { code: 'invalid_input', error: `invalid cockpit url: ${url}` });
  }
}

export async function discoverCockpit(options: DiscoverOptions): Promise<Cockpit> {
  const root = await checkoutRoot(options.repoDir, options.signal);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const hint = `start the cockpit in ${root} with: ${productIdentity().command}`;
  if (options.url) {
    const origin = parseCockpitOrigin(options.url);
    const found = await probe(origin, Math.max(timeoutMs, 5_000), options.signal, options.fetch);
    if (!found) throw new TaskCliError(2, { code: 'no-cockpit', error: `no Squawk cockpit answered at ${origin}`, hint });
    // A remote cockpit's roots are its own paths, so no match is the ordinary case there.
    const match = found.projects.find((entry) => entry.root === root);
    const id = match?.id ?? found.bootProject;
    return cockpitForProject(origin, id, options.fetch);
  }
  const ports = options.ports ?? COCKPIT_PORTS;
  const candidates = await Promise.all(ports.map((port) => probe(`http://127.0.0.1:${port}`, timeoutMs, options.signal, options.fetch)));
  // `ports` is ascending, so the first match is the lowest port serving this checkout.
  for (const candidate of candidates) {
    const match = candidate?.projects.find((entry) => entry.root === root);
    if (candidate && match) return cockpitForProject(candidate.origin, match.id, options.fetch);
  }
  throw new TaskCliError(2, { code: 'no-cockpit', error: `no running cockpit serves ${root}`, hint });
}

export interface DiscoverOriginOptions {
  /** Explicit `--url` or `HSQ_URL` / `CEZ_URL`. */
  url?: string | undefined;
  /** Checkout directory to match first (defaults to cwd when omitted). */
  repoDir?: string | undefined;
  /** True when the caller explicitly passed `--repo`: do not fall back to another cockpit. */
  explicitRepo?: boolean | undefined;
  ports?: readonly number[] | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetch?: FetchFn | undefined;
}

/**
 * Discover a running cockpit's origin without selecting a boot project (spec 2026-11-27-orchestrator-mcp-server).
 * Matches `url` directly when provided; otherwise probes local ports, preferring a cockpit serving
 * `repoDir`, and falling back to the single running local cockpit when `--repo` was not explicitly set.
 */
export async function discoverCockpitOrigin(options: DiscoverOriginOptions): Promise<{ origin: string }> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const cmd = productIdentity().command;
  if (options.url) {
    const origin = parseCockpitOrigin(options.url);
    const found = await probe(origin, Math.max(timeoutMs, 5_000), options.signal, options.fetch);
    if (!found) {
      throw new TaskCliError(2, {
        code: 'no-cockpit',
        error: `no Squawk cockpit answered at ${origin}`,
        hint: `start the cockpit with: ${cmd}`,
      });
    }
    return { origin };
  }
  const ports = options.ports ?? COCKPIT_PORTS;
  const candidates = await Promise.all(ports.map((port) => probe(`http://127.0.0.1:${port}`, timeoutMs, options.signal, options.fetch)));
  const live = candidates.filter((candidate): candidate is Candidate => candidate !== undefined);
  const root = options.repoDir ? await checkoutRoot(options.repoDir, options.signal) : undefined;
  if (root) {
    const matched = live.find((candidate) => candidate.projects.some((entry) => entry.root === root));
    if (matched) return { origin: matched.origin };
    if (options.explicitRepo) {
      throw new TaskCliError(2, {
        code: 'no-cockpit',
        error: `no running cockpit serves ${root}`,
        hint: `start the cockpit in ${root} with: ${cmd}`,
      });
    }
  }
  if (live.length === 1) return { origin: live[0]!.origin };
  if (live.length > 1) {
    const origins = live.map((candidate) => candidate.origin);
    throw new TaskCliError(2, {
      code: 'ambiguous-cockpit',
      error: `multiple running Squawk cockpits found (${origins.join(', ')}); pass --url <origin> or --repo <dir> to select one`,
      origins,
      hint: `re-run with --url ${origins[0]} or --repo <dir>`,
    });
  }
  throw new TaskCliError(2, {
    code: 'no-cockpit',
    error: root ? `no running cockpit serves ${root}` : 'no running Squawk cockpit found',
    hint: root ? `start the cockpit in ${root} with: ${cmd}` : `start the cockpit with: ${cmd}`,
  });
}

/** The env address first; discovery only when the caller named a cockpit or a checkout. */
export async function resolveCockpit(
  env: NodeJS.ProcessEnv,
  values: { url?: string; repo?: string },
  discover: ((options: DiscoverOptions) => Promise<Cockpit>) | undefined,
  noCockpit: string,
  options: { removeDiscoveryHint?: boolean } = {},
): Promise<Cockpit> {
  const address = productEnv('COCKPIT_URL', env)?.trim();
  const projectId = productEnv('PROJECT_ID', env)?.trim();
  if (address && projectId) {
    let origin: string;
    try { origin = new URL(address).origin; } catch {
      throw new TaskCliError(2, { code: 'no-cockpit', error: `CEZ_COCKPIT_URL is not a URL: ${address}` });
    }
    return { origin, projectId, api: `${origin}/api/v1/p/${encodeURIComponent(projectId)}` };
  }
  const url = values.url ?? (productEnv('URL', env)?.trim() || undefined);
  if (url === undefined && values.repo === undefined) throw new TaskCliError(2, { code: 'no-cockpit', error: noCockpit });
  try {
    return await (discover ?? discoverCockpit)({ url, repoDir: resolve(values.repo ?? process.cwd()) });
  } catch (error) {
    // Discovery's hint says to start a cockpit; this command never suggests that.
    if (options.removeDiscoveryHint && error instanceof TaskCliError) {
      const { hint: _hint, ...body } = error.body;
      throw new TaskCliError(error.exitCode, body);
    }
    throw error;
  }
}
