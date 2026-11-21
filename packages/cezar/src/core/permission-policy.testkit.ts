import type { AgentSession } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { waitFor } from './harness-parity-core.testkit.ts';
/** Unset grants leave native approvals to the caller. Restricting grants answer from policy. */
export async function allowProbePermissions(session: AgentSession, observed: { v1: readonly { type: string }[]; v2: readonly UiEvent[] }): Promise<void> {
  const answered = new Set<string>();
  await waitFor(() => {
    for (const event of observed.v2) {
      if (event.type !== 'permission.requested' || answered.has(event.requestId)) continue;
      answered.add(event.requestId);
      const option = event.options.find(option => option.kind === 'allow_once');
      if (option) session.respondPermission?.(event.requestId, option.id);
    }
    return observed.v1.some(event => event.type === 'turn-end' || event.type === 'error');
  });
}
export function policyResponses(recording: readonly string[]): string[] {
  const answers = new Map<string, string>();
  for (const line of recording) {
    const frame = JSON.parse(line);
    if (typeof frame.id === 'string' && frame.id.startsWith('policy-') && frame.result?.outcome) answers.set(frame.id, frame.result.outcome.optionId ?? 'cancelled');
  }
  return [...answers.values()];
}
