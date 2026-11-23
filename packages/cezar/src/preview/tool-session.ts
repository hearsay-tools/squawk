import type { CiToolSession } from '../ci-wait/controller.ts';
import type { RunStore } from '../runs/store.ts';
import { previewCdpSession, previewRunContext, type PreviewHostLike } from './registration.ts';

export function decoratePreviewSession(session: CiToolSession, store: RunStore, dataDir: string, runId: string, host: PreviewHostLike | undefined, cockpitOrigin: string | undefined): CiToolSession {
  return previewCdpSession(session, { host, cockpitOrigin, runId, worktree: !!store.getRun(runId)?.worktreePath, context: () => previewRunContext(store, dataDir, runId) });
}

/** Bind the trusted run identity before the tool accepts model input. */
export function previewSessionHandlers(host: Pick<import('../workflows/run/squawk-tools.ts').ToolHost, 'registerPreviewServer' | 'stopPreviewServer'>, runId: string): Pick<import('../ci-wait/controller.ts').SquawkToolHandlers, 'registerPreview' | 'stopPreview'> {
  return { registerPreview: (request, signal) => host.registerPreviewServer(runId, request, signal), stopPreview: (request, signal) => host.stopPreviewServer(runId, request, signal) };
}
