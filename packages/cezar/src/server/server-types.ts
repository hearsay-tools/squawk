import { streamSSE } from 'hono/streaming';
import type { ProjectContext } from './project-context.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import type { resolveCapabilities } from './capabilities.ts';
import type { createProviderStatus, resolveServerDeps } from './server-deps.ts';

/** Hono env for the mirrored project-route table: the scope resolver puts the
 *  request's `ProjectContext` on the context, handlers read `c.get('project')`. */
export type ProjectApiEnv = { Variables: { project: ProjectContext; stoppedOnAdoption?: boolean } };

export const hostedProfileRefusal = {
  error: 'agent accounts are managed from the machine that owns the checkout (this cockpit runs in hosted mode)',
};

export const UI_STATE_BODY_LIMIT = 128 * 1024; // 128 KiB

/** Workspace-level event names carried ONLY on `GET /api/workspace/events`. */
export type WorkspaceEventName =
  | 'project-added'
  | 'project-removed'
  | 'checkout-progress'
  | 'health'
  | 'provider-status'
  | 'automation-change'
  | 'project-ready';

/**
 * The in-process bus for workspace-level SSE events.
 */
export class WorkspaceEventBus {
  private readonly listeners = new Set<(event: WorkspaceEventName, data: unknown) => void>();

  emit(event: WorkspaceEventName, data: unknown): void {
    for (const listener of [...this.listeners]) listener(event, data);
  }

  /** Subscribe; returns an unsubscribe. */
  on(listener: (event: WorkspaceEventName, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** streamSSE with the anti-buffering contract (#424). */
export const streamSSENoBuffer: typeof streamSSE = (c, cb, onError) => {
  const res = streamSSE(c, cb, onError);
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
};

export function writeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ServerCapabilitiesFn = () => ReturnType<typeof resolveCapabilities>;
export type ProviderStatusBundle = ReturnType<typeof createProviderStatus>;
export type ResolvedServerDeps = ReturnType<typeof resolveServerDeps>;
export type ResolveWorkspaceProfileFn = (
  provider: ProviderId,
  profileId?: string,
) => Promise<{ profile: ResolvedAgentProfile } | { error: string }>;
