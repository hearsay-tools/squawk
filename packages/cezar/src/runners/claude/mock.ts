import type { RunnerMock } from '../../core/runner-definition.ts';
import { MOCK_BASELINE_PROMPT } from '../mock-prompts.ts';

/** The claude runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const CLAUDE_MOCK = {
  askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_CLAUDE_BIN',
  script: 'mock-claude.mjs',
  scenarios: {
    'input-closed-live': 'mock:no-progress-input-closed',
    'multi-pr-refs': 'mock:multi-pr-refs',
    'turn-messages': 'mock:turn-messages',
    'missing-binary': MOCK_BASELINE_PROMPT,
    autonomous: 'mock:autonomous',
    'autonomous-cap': 'mock:autonomous-cap',
    'autonomous-silent': 'mock:autonomous-silent',
    'autonomous-cezar-ask-cap': 'mock:autonomous-cezar-ask-cap',
    'silent-tail': 'mock:silent-tail',
    'silent-tail-no-reply': 'mock:silent-tail-no-reply',
    'silent-tail-late-reply': 'mock:silent-tail-late-reply',
    'silent-tail-slow-done': 'mock:silent-tail-slow-done',
    baseline: MOCK_BASELINE_PROMPT,
    'no-progress-ack-only': MOCK_BASELINE_PROMPT,
    'crash-stderr-pre-ack': 'mock:crash-stderr-pre-ack',
    'crash-stderr-held-pipe': 'mock:crash-stderr-held-pipe',
    'shutdown-stderr': 'mock:crash-stderr-clean',
    'crash-stderr': 'mock:crash-stderr',
    'crash-stderr-single': 'mock:crash-stderr-single',
    'cezar-done': 'mock:cezar-done',
    hold: 'mock:hold', 'hold-gated': 'mock:hold-gated', 'hold-cezar-done': 'mock:hold-cezar-done', 'hold-cezar-ask': 'mock:hold-cezar-ask', 'no-progress': 'mock:no-progress', 'no-progress-ignore-term': 'mock:no-progress-ignore-term', 'no-progress-held-pipe': 'mock:no-progress-held-pipe', 'no-progress-leftover': 'mock:no-progress-leftover', 'busy-progress': 'mock:busy-progress',
    // `mock:auth-error` is a gated failure-control prompt; the control's provider failure is a 400.
    'provider-error': 'mock:request-error', 'provider-error-controlled': 'mock:auth-error',
    'provider-unavailable': 'mock:provider-unavailable',
    'provider-rate-limit': 'mock:provider-rate-limit', 'provider-not-found': 'mock:provider-not-found', 'provider-credit': 'mock:provider-credit',
    'post-success-refusal': 'mock:model-refusal:always',
    ask: 'mock:cezar-ask',
    'ask-resume': 'mock:cezar-ask mock:resume-cezar-done',
    'ask-reply-late': 'mock:cezar-ask',
    subagent: 'mock:subagents',
    'subagent-after-park': 'mock:subagent-after-park',
    'forked-skill': 'mock:forked-skill',
    'hook-after-park': 'mock:hook-after-park',
    'steer-tool': 'mock:steer-tool',
    // A line written after the last model call runs as the CLI's next queued turn.
    'steer-late': 'mock:hold',
  },
} as const satisfies RunnerMock;
