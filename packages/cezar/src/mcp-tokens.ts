/**
 * Per-port hashed bearer tokens for the Streamable HTTP MCP endpoint (`/api/v1/mcp`,
 * hearsay-tools/squawk#4402). Follows the ADR 0055 per-port host-CLI pattern (`remote-settings.ts`):
 *
 * - Each cockpit listen port gets its own file `<config>/mcp-tokens/<port>.json` written atomically
 *   with mode `0600` through `HomeStore`, so multi-domain installs on one host stay isolated.
 * - Only SHA-256 hashes are stored on disk; raw tokens (`hsq_mcp_<base64url(32 bytes)>`) are printed
 *   once on creation and compared per request with `crypto.timingSafeEqual`.
 * - Reads fail closed: a missing, malformed, or unreadable file authorizes nothing.
 * - Optional `HSQ_MCP_TOKEN` (`CEZ_MCP_TOKEN` fallback) grants unscoped bearer access for container
 *   or systemd deployments alongside any per-port file tokens.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { productEnv } from './core/product-env.ts';
import type { Home } from './home/home.ts';
import { HomeStore, readHomeFile } from './home/store.ts';

export const MCP_TOKENS_DIR = 'mcp-tokens';
export const MCP_TOKEN_PREFIX = 'hsq_mcp_';

const TOKEN_FILE = /^([1-9]\d{0,4})\.json$/;

const storedTokenSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  project: z.string().trim().min(1).refine((value) => value !== 'all', 'project scope cannot be "all"').optional(),
}).strict();

const tokenFileSchema = z.object({
  tokens: z.array(storedTokenSchema),
}).strict();

export type StoredMcpToken = z.infer<typeof storedTokenSchema>;

export interface McpTokenPublic {
  id: string;
  name: string;
  port: number;
  createdAt: string;
  project?: string;
}

export interface CreatedMcpToken extends McpTokenPublic {
  token: string;
  path: string;
}

export interface McpTokenListState {
  tokens: McpTokenPublic[];
  path: string;
  issue?: string;
}

export interface VerifiedMcpToken {
  source: 'file' | 'env';
  id?: string;
  name?: string;
  project?: string;
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function mcpTokensDir(home: Home): string {
  return home.mcpTokens;
}

export function mcpTokenFile(port: number, home: Home): string {
  return join(home.mcpTokens, `${port}.json`);
}

export function hashMcpToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function digestMatchesHex(rawToken: string, expectedHex: string): boolean {
  const actual = createHash('sha256').update(rawToken, 'utf8').digest();
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}

function envMcpToken(env: NodeJS.ProcessEnv): string | undefined {
  const value = productEnv('MCP_TOKEN', env)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function toPublic(entry: StoredMcpToken, port: number): McpTokenPublic {
  return {
    id: entry.id,
    name: entry.name,
    port,
    createdAt: entry.createdAt,
    ...(entry.project !== undefined ? { project: entry.project } : {}),
  };
}

function readOptionalHomeFile(path: string, home: Home): { content: string } | { issue: string } | null {
  try {
    return { content: readHomeFile(path, home) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    const detail = error instanceof Error ? error.message : String(error);
    return { issue: `cannot read ${path}: ${detail}` };
  }
}

function parsePortTokenJson(content: string, path: string): { tokens: StoredMcpToken[] } | { issue: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    return { issue: `${path} is not a valid MCP token store` };
  }
  const validated = tokenFileSchema.safeParse(decoded);
  return validated.success
    ? { tokens: validated.data.tokens }
    : { issue: `${path} is not a valid MCP token store` };
}

/** Read one port's token file. Never throws; malformed or unreadable files fail closed with `issue`. */
function readPortTokenFile(port: number, home: Home): { tokens: StoredMcpToken[] } | { issue: string } | null {
  const path = mcpTokenFile(port, home);
  const loaded = readOptionalHomeFile(path, home);
  if (loaded === null || 'issue' in loaded) return loaded;
  return parsePortTokenJson(loaded.content, path);
}

/** True when at least one bearer token is configured for `port` (file or env). Read per request. */
export function hasConfiguredMcpTokens(env: NodeJS.ProcessEnv, port: number | undefined, home: Home): boolean {
  if (envMcpToken(env) !== undefined) return true;
  if (port === undefined || !isPort(port)) return false;
  const loaded = readPortTokenFile(port, home);
  return loaded !== null && 'tokens' in loaded && loaded.tokens.length > 0;
}

/** Verify a raw bearer token against env and the port's hashed token file using constant-time digests. */
export function verifyMcpBearerToken(
  rawToken: string,
  env: NodeJS.ProcessEnv,
  port: number | undefined,
  home: Home,
): VerifiedMcpToken | null {
  if (!rawToken) return null;
  const envToken = envMcpToken(env);
  if (envToken !== undefined && digestMatchesHex(rawToken, hashMcpToken(envToken))) {
    return { source: 'env' };
  }
  if (port === undefined || !isPort(port)) return null;
  const loaded = readPortTokenFile(port, home);
  if (loaded === null || !('tokens' in loaded)) return null;
  let matched: StoredMcpToken | null = null;
  for (const entry of loaded.tokens) {
    if (digestMatchesHex(rawToken, entry.sha256) && matched === null) {
      matched = entry;
    }
  }
  if (!matched) return null;
  return {
    source: 'file',
    id: matched.id,
    name: matched.name,
    ...(matched.project !== undefined ? { project: matched.project } : {}),
  };
}

function listTokenPorts(home: Home): number[] {
  let names: string[];
  try {
    names = readdirSync(home.mcpTokens);
  } catch {
    return [];
  }
  const ports: number[] = [];
  for (const name of names) {
    const match = TOKEN_FILE.exec(name);
    if (!match) continue;
    const port = Number(match[1]);
    if (isPort(port)) ports.push(port);
  }
  return ports.sort((a, b) => a - b);
}

/** List configured MCP tokens (metadata only; never hashes or raw secrets). */
export function listMcpTokens(home: Home, port?: number): McpTokenListState {
  if (port !== undefined && !isPort(port)) throw new RangeError(`not a port: ${port}`);
  const ports = port !== undefined ? [port] : listTokenPorts(home);
  const tokens: McpTokenPublic[] = [];
  const issues: string[] = [];
  for (const p of ports) {
    const loaded = readPortTokenFile(p, home);
    if (loaded === null) continue;
    if ('issue' in loaded) issues.push(loaded.issue);
    else tokens.push(...loaded.tokens.map((entry) => toPublic(entry, p)));
  }
  tokens.sort((a, b) => a.port - b.port || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return {
    tokens,
    path: home.mcpTokens,
    ...(issues.length > 0 ? { issue: issues.join('; ') } : {}),
  };
}

export interface CreateMcpTokenOptions {
  port: number;
  home: Home;
  name?: string | undefined;
  project?: string | undefined;
  now?: Date | undefined;
}

/** Generate a new bearer token for `port`, persist only its SHA-256 digest via `HomeStore`, and return the raw token once. */
export function createMcpToken(options: CreateMcpTokenOptions): CreatedMcpToken {
  const { port, home } = options;
  if (!isPort(port)) throw new RangeError(`not a port: ${port}`);
  const name = options.name?.trim() || 'default';
  let project: string | undefined;
  if (options.project !== undefined) {
    const trimmed = options.project.trim();
    if (!trimmed) throw new RangeError('project scope must not be empty');
    if (trimmed === 'all') throw new RangeError('project scope cannot be "all"');
    project = trimmed;
  }
  const now = options.now ?? new Date();
  const path = mcpTokenFile(port, home);
  const rawToken = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const record: StoredMcpToken = {
    id: randomBytes(6).toString('hex'),
    name,
    sha256: hashMcpToken(rawToken),
    createdAt: now.toISOString(),
    ...(project !== undefined ? { project } : {}),
  };
  const store = new HomeStore(home);
  store.transaction(() => {
    const existing = readPortTokenFile(port, home);
    if (existing !== null && 'issue' in existing) {
      throw new Error(`Refusing to overwrite corrupt MCP token store: ${existing.issue}`);
    }
    const tokens = existing ? [...existing.tokens, record] : [record];
    store.writeJson(path, { tokens });
  }, [home.mcpTokens, path]);
  return { ...toPublic(record, port), token: rawToken, path };
}

export interface RevokeMcpTokenResult {
  revoked: McpTokenPublic[];
  path: string;
}

export class McpTokenRevokeError extends Error {
  readonly code: 'not_found' | 'ambiguous_port' | 'corrupt_store';
  readonly ports: number[] | undefined;

  constructor(
    code: 'not_found' | 'ambiguous_port' | 'corrupt_store',
    message: string,
    ports?: number[],
  ) {
    super(message);
    this.name = 'McpTokenRevokeError';
    this.code = code;
    this.ports = ports;
  }
}

/** Revoke one token by `id`, or every token on `port` when `all` is true. Takes effect on the next request. */
export function revokeMcpToken(options: { home: Home; id?: string | undefined; port?: number | undefined; all?: boolean | undefined }): RevokeMcpTokenResult {
  const { home, id, port, all } = options;
  if (port !== undefined && !isPort(port)) throw new RangeError(`not a port: ${port}`);
  const store = new HomeStore(home);

  if (all) {
    if (port === undefined) throw new RangeError('--all requires --port <n>');
    const path = mcpTokenFile(port, home);
    let revoked: McpTokenPublic[] = [];
    store.transaction(() => {
      const existing = readPortTokenFile(port, home);
      if (existing !== null && 'tokens' in existing) {
        revoked = existing.tokens.map((entry) => toPublic(entry, port));
      }
      store.replace(path, null);
    }, [home.mcpTokens, path]);
    return { revoked, path };
  }

  const targetId = id?.trim();
  if (!targetId) throw new RangeError('token id is required');

  const candidatePorts = port !== undefined ? [port] : listTokenPorts(home);
  const candidatePaths = candidatePorts.map((p) => mcpTokenFile(p, home));
  let revoked: McpTokenPublic | undefined;
  let targetPath = home.mcpTokens;

  store.transaction(() => {
    const matches: Array<{ port: number; tokens: StoredMcpToken[]; entry: StoredMcpToken }> = [];
    for (const p of candidatePorts) {
      const loaded = readPortTokenFile(p, home);
      if (loaded === null) continue;
      if ('issue' in loaded) {
        if (port !== undefined) throw new McpTokenRevokeError('corrupt_store', loaded.issue);
        continue;
      }
      const found = loaded.tokens.find((entry) => entry.id === targetId);
      if (found) matches.push({ port: p, tokens: loaded.tokens, entry: found });
    }
    if (matches.length === 0) {
      const where = port !== undefined ? ` on port ${port}` : '';
      throw new McpTokenRevokeError('not_found', `MCP token '${targetId}' was not found${where}.`);
    }
    if (matches.length > 1) {
      const matchedPorts = matches.map((m) => m.port);
      throw new McpTokenRevokeError(
        'ambiguous_port',
        `MCP token '${targetId}' exists on multiple ports (${matchedPorts.join(', ')}); pass --port <n>.`,
        matchedPorts,
      );
    }
    const match = matches[0]!;
    targetPath = mcpTokenFile(match.port, home);
    const remaining = match.tokens.filter((entry) => entry.id !== targetId);
    if (remaining.length === 0) store.replace(targetPath, null);
    else store.writeJson(targetPath, { tokens: remaining });
    revoked = toPublic(match.entry, match.port);
  }, [home.mcpTokens, ...candidatePaths]);

  return { revoked: revoked ? [revoked] : [], path: targetPath };
}

/** Remove the port's MCP token file when a cockpit is uninstalled or freshly installed on that port. */
export function clearMcpTokensForPort(port: number, home: Home): boolean {
  if (!isPort(port)) return false;
  const path = mcpTokenFile(port, home);
  const existing = readPortTokenFile(port, home);
  if (existing === null) return false;
  const store = new HomeStore(home);
  store.transaction(() => {
    store.replace(path, null);
  }, [home.mcpTokens, path]);
  return true;
}
