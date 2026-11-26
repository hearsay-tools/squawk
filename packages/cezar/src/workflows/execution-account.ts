import { latestSession } from '@open-mercato/cezar-contract/run-predicates';

import type { RunRecord } from '../runs/store.ts';
import { DEFAULT_RUNNER_ID } from '../core/runner-ids.ts';

/**
 * Resolve the next turn’s account: live step, queued continuation, latest session-owning step,
 * then run-level fields. Use this result for usage-limit holds in mixed-runner workflows.
 */
export function executionAccount(
  run: Pick<RunRecord, 'runner' | 'agentProfile' | 'steps'>,
  continuation?: { backend: string; sessionId?: string | undefined },
  live?: { runner: string; agentProfile?: string },
): Pick<RunRecord, 'runner' | 'agentProfile'> {
  if (live) return { runner: live.runner, agentProfile: live.agentProfile };
  if (continuation) {
    const owning = continuation.sessionId === undefined ? undefined : run.steps.find((candidate) => candidate.sessionId === continuation.sessionId);
    const runAccount = continuation.backend === (run.runner ?? DEFAULT_RUNNER_ID) ? run.agentProfile : undefined;
    return { runner: continuation.backend, agentProfile: owning?.profileId ?? runAccount };
  }
  const latest = latestSession(run);
  if (latest.sessionId !== undefined) return { runner: latest.backend, agentProfile: latest.profileId ?? run.agentProfile };
  return { runner: run.runner, agentProfile: run.agentProfile };
}
