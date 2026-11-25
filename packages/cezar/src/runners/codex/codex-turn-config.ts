import { parseEffort } from '@hearsay-tools/squawk/plugin/runtime';
import { type AgentRunSpec, productEnv } from '@hearsay-tools/squawk/plugin';

const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);

/**
 * The reasoning-summary override sent on `turn/start` (TurnStartParams.summary).
 * Defaults to `auto` so reasoning is visible out of the box — without it the
 * app-server runs with its own default (no summary) and the reasoning thread
 * stays empty even when the model reasons. `CEZ_CODEX_REASONING` overrides the
 * default (`auto`/`concise`/`detailed`, or `none` to opt out); an unrecognized
 * value falls back to `auto`.
 */
export function reasoningSummary(env: NodeJS.ProcessEnv = process.env): string {
  const raw = productEnv('CODEX_REASONING', env)?.trim().toLowerCase();
  if (!raw) return 'auto';
  return REASONING_SUMMARIES.has(raw) ? raw : 'auto';
}

/**
 * Fields sent on `turn/start` besides thread/input. `summary` is the existing
 * `CEZ_CODEX_REASONING` knob (out of scope for #45). `effort` is the per-run
 * pin — omitted when unset so the app-server keeps its default.
 */
export function codexTurnStartExtras(
  spec: Pick<AgentRunSpec, 'effort'>,
  env: NodeJS.ProcessEnv = process.env,
): { summary: string; effort?: string } {
  const effort = parseEffort(spec.effort);
  return {
    summary: reasoningSummary(env),
    ...(effort ? { effort } : {}),
  };
}

