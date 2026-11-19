import { z } from 'zod';

// Codex owns policy interpretation. Even requirements we do not recognize can
// constrain permissions; only an explicit null proves the unmanaged case.
const requirementsResponse = z.object({
  requirements: z.null(),
});

export function codexPermissionOverrides(response: unknown, restrictNetwork: boolean) {
  const parsed = requirementsResponse.safeParse(response);
  if (parsed.success && parsed.data.requirements === null) {
    // Full access keeps unmanaged container installs working when bubblewrap
    // cannot create a UID map (#563). Never select it on an unknown policy.
    return { sandbox: restrictNetwork ? 'workspace-write' : 'danger-full-access' };
  }
  // A managed default is a fallback, not a mandate to replace an allowed saved
  // read-only profile on resume. Codex resolves both defaults and saved profiles.
  return {};
}

/** A minimal session (`AgentRunSpec.minimal`) runs read-only, because the app-server ignores
 *  `toolGrant`. That holds under a confirmed unmanaged policy and when discovery failed
 *  (`response` undefined): read-only never widens an unknown policy, and Codex refuses it when the
 *  policy forbids it. A discovered managed policy belongs to Codex. */
export function codexMinimalSandbox(response: unknown): { sandbox?: 'read-only' } {
  return response === undefined || requirementsResponse.safeParse(response).success ? { sandbox: 'read-only' } : {};
}

export function codexNetworkIsRestricted(response: Record<string, unknown>): boolean {
  const parsed = z.object({ sandbox: z.discriminatedUnion('type', [
    // Older app-server versions omit networkAccess on readOnly (restricted).
    z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false).optional() }),
    z.object({ type: z.literal('workspaceWrite'), networkAccess: z.literal(false) }),
    z.object({ type: z.literal('externalSandbox'), networkAccess: z.literal('restricted') }),
  ]) }).safeParse(response);
  return parsed.success;
}
