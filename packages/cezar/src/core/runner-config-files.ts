
/**
 * The shape of one native config file that Settings → Agent config shows. Each runner's
 * definition lists its files in `configFiles` (`runners/<id>/config-files.ts`), and
 * `agent-config/catalog.ts` reads them from the registry. Paths, formats, precedence
 * descriptions and documentation URLs are maintained by hand; unknown files are not guessed.
 */

export type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'yaml' | 'markdown';
export type ConfigScope = 'user' | 'project' | 'local';
/** `settings` = behavior knobs; `memory` = instruction/markdown; `mcp` = a dedicated MCP file. */
export type ConfigKind = 'settings' | 'memory' | 'mcp';
/**
 * Git status *by convention* — it drives the honest label, it is not read from
 * git. The seed path re-checks with `git check-ignore` before trusting it.
 */
export type ConfigTracked = 'tracked' | 'gitignored' | 'outside-repo';

/**
 * Each registered runner's default home, keyed by its `accounts.homeSlot`. `agentHomePaths()`
 * (paths.ts) builds it from the registry and injects it, so the catalog stays pure and testable.
 */
export type AgentHomePaths = Readonly<Record<string, string>>;

/** The home in `slot`. Throws naming the slot when no registered runner declares it. */
export function agentHome(home: AgentHomePaths, slot: string): string {
  const dir = home[slot];
  if (dir === undefined) throw new Error(`No registered runner declares the agent home slot ${slot}.`);
  return dir;
}

/**
 * One native config file in a runner's `configFiles.files`. Its readers are not listed here: a
 * file that several runners read (`<repo>/AGENTS.md`) is one object that each of them lists.
 */
export interface RunnerConfigFile {
  /** Stable, opaque, URL-safe. The ONLY thing a client may name (traversal-proof). */
  id: string;
  kind: ConfigKind;
  scope: ConfigScope;
  /** Absolute path, resolved per request so `$CODEX_HOME`/`$XDG_CONFIG_HOME` are honoured. */
  resolve: (repoRoot: string, home: AgentHomePaths) => string;
  /** What the user sees, e.g. `~/.claude/settings.json`, `.claude/settings.local.json`. */
  label: string;
  format: ConfigFormat;
  tracked: ConfigTracked;
  /** True only for Claude's gitignored personal layer — the files seeded into a run's worktree. */
  seeded?: boolean;
  /** True when this file holds MCP server definitions (drives the MCP section's filter). */
  holdsMcp?: boolean;
  /** Top-level native setting that supplies the agent's new-session model, when present. */
  modelKey?: string;
  /** Native model keys checked in precedence order, including nested `env.*` settings. */
  modelKeys?: readonly string[];
  /** Native provider key paired with the model, when the vendor separates the two. */
  modelProviderKey?: string;
  /** Higher values win when resolving a native default model across config scopes. */
  modelPriority?: number;
  /** VERBATIM from the vendor docs. Never computed, never generic. */
  precedence: string;
  /** Documented mid-run reload behaviour, or undefined when the vendor is silent. */
  hotReload?: string;
  docsUrl: string;
}

/** A catalog entry (`agent-config/catalog.ts`): a {@link RunnerConfigFile} and its readers. */
export interface ConfigFileDef extends RunnerConfigFile {
  /** Every registered runner that lists this file in its `configFiles.files`, in registration order. */
  runners: string[];
}
