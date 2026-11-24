import { z } from 'zod';
import { repoInfoSchema } from './repo-info.ts';
import { runnerSchema } from './runner.ts';

export { runnerSchema, type Runner } from './runner.ts';
export { repoInfoSchema, type RepoInfo } from './repo-info.ts';

/** One probed CLI behind the Tools menu. */
export const backendCheckSchema = z.object({
  /** A runner id, `gh` or `git`. */
  name: z.string().min(1),
  available: z.boolean(),
  version: z.string().optional(),
  hint: z.string().optional(),
});
export type BackendCheck = z.infer<typeof backendCheckSchema>;

export const forgeInfoSchema = z.object({
  kind: z.literal('github'),
  /**
   * Whether the forge is reachable — **absent until the availability probe has warmed**.
   *
   * Health must never pay a `gh` shell-out, so it serves whatever the cache holds. Absent means
   * "not determined yet", which is not the same as `false`, and the cockpit renders the two
   * differently. Declaring it required is what made an earlier hand-written mirror wrong.
   */
  available: z.boolean().optional(),
  reason: z.string().optional(),
});
export type ForgeInfo = z.infer<typeof forgeInfoSchema>;

/** Server-side feature switches the cockpit reads once at boot. */
export const capabilitiesSchema = z.object({
  localHandoff: z.boolean(),
  /**
   * `true` means this cockpit may edit Agent config and worktree setup, and complete browser sign-in: it is local, or the host
   * operator ran `cez remote-settings enable` for this cockpit's listen port and it binds loopback
   * (hearsay-tools/cezarion#2428). The editors persist host commands; sign-in writes host credentials.
   */
  settingsAdmin: z.boolean(),
  /** `true` when `settingsAdmin` comes from the host switch on a remote cockpit, not from a local one. */
  remoteSettingsAdmin: z.boolean(),
  /**
   * `true` by default; only `CEZ_AUTOMATIONS=0` disables automations. When disabled,
   * the whole feature is absent: no `Automations` nav item anywhere it is rendered, the
   * `/api/v1/…/automations*` family answers `409`, and the workspace scheduler never polls GitHub.
   *
   * REQUIRED for the same reason as `tokenMetrics` below: this server always sends it.
   */
  automations: z.boolean(),
  /**
   * `true` means `CEZ_PREVIEW=1` opted this server into live preview (#781): the `cezar_preview_serve`
   * tool is listed, its route answers, the preview WebSocket upgrades and the cockpit offers the
   * pane. Off — the default — every one of those is absent.
   *
   * REQUIRED for the same reason as `tokenMetrics` below: this server always sends it.
   */
  preview: z.boolean(),
  /**
   * `false` means `CEZ_HIDE_TOKEN_METRICS=1` asks the browser to omit token counts and monetary
   * cost (#481). The telemetry itself still rides in run/event payloads — this is presentation
   * only.
   *
   * REQUIRED, because this server always sends it (`capabilities.ts` computes it from the env on
   * every read) and this contract describes THIS server's wire. The DTO it replaces declared it
   * optional so a newer cockpit could read an OLDER server, which is version skew a contract
   * versioned in lockstep with the server cannot model. That tolerance lives where it belongs, in
   * `web/src/lib/token-metrics.ts`, whose `!== false` read still treats an absent field as
   * visible.
   */
  tokenMetrics: z.boolean(),
  /** Current token-count presentation policy. Required on current servers;
   * older payload tolerance belongs in the browser resolver. */
  tokenUsageMetrics: z.boolean(),
  /** Current backend-reported-cost presentation policy. */
  costMetrics: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** One plugin the server loaded from a plugin folder. */
export const pluginHealthEntrySchema = z.object({
  /** The plugin's folder name. */
  name: z.string(),
  /** `bundled` ships inside Squawk; `host` comes from `<config>/plugins/`. */
  source: z.enum(['bundled', 'host']),
  /** The plugin's folder. Absent in hosted mode (`HSQ_REMOTE=1` or a non-loopback bind). */
  path: z.string().optional(),
});
export type PluginHealthEntry = z.infer<typeof pluginHealthEntrySchema>;

/** One plugin the server skipped. In hosted mode `error` carries `<path>` for every host path. */
export const failedPluginHealthEntrySchema = pluginHealthEntrySchema.extend({ error: z.string() });
export type FailedPluginHealthEntry = z.infer<typeof failedPluginHealthEntrySchema>;

/**
 * The plugins this server process loaded and skipped. Always sent; a server without plugins
 * sends two empty lists.
 */
export const pluginsHealthSchema = z.object({
  loaded: z.array(pluginHealthEntrySchema),
  failed: z.array(failedPluginHealthEntrySchema),
});
export type PluginsHealth = z.infer<typeof pluginsHealthSchema>;

/**
 * `GET /api/v1/health` — the CORS-open discovery endpoint. Callers outside the cockpit read
 * this JSON.
 */
export const healthResponseSchema = z.object({
  version: z.string(),
  latestVersion: z.string().optional(),
  repoRoot: z.string(),
  repo: repoInfoSchema.nullable(),
  checks: z.array(backendCheckSchema),
  defaultRunner: runnerSchema,
  forge: forgeInfoSchema.nullable(),
  capabilities: capabilitiesSchema,
  // Always sent: `workspaceSummary()` returns both unconditionally, and an unreadable workspace
  // degrades to `projects: []` rather than to an absent key. The hand-written DTO declared them
  // optional, which was wider than the server has ever been.
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  bootProject: z.string(),
  plugins: pluginsHealthSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
