/**
 * Prompt text shared by the runners' `mock.ts` files (the `mock` part of a definition). Data only:
 * a definition module imports no test code. Each table holds the scenarios that exactly the named
 * runners answer with the same prompt; a runner's own `mock.ts` lists the rest.
 */

/** No marker: every mock's default branch answers this with its scripted turn. */
export const MOCK_BASELINE_PROMPT = 'inspect the working tree';

/** Every runner answers these scenarios with the same prompt. */
export const COMMON_MOCK_SCENARIOS = {
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
  hold: 'mock:hold',
  'hold-gated': 'mock:hold-gated',
  'hold-cezar-done': 'mock:hold-cezar-done',
  'hold-cezar-ask': 'mock:hold-cezar-ask',
  'no-progress': 'mock:no-progress',
  'no-progress-ignore-term': 'mock:no-progress-ignore-term',
  'no-progress-held-pipe': 'mock:no-progress-held-pipe',
  'no-progress-leftover': 'mock:no-progress-leftover',
  'busy-progress': 'mock:busy-progress',
  'provider-rate-limit': 'mock:provider-rate-limit',
  'provider-not-found': 'mock:provider-not-found',
  'provider-credit': 'mock:provider-credit',
  'steer-tool': 'mock:steer-tool',
} as const;

/** The runners whose ask crosses the `cezar_ask` tool on a stdio wire. */
export const STDIO_ASK_MOCK_SCENARIOS = {
  ask: 'mock:cezar-ask',
  'ask-resume': 'mock:cezar-ask mock:resume-cezar-done',
  'ask-reply-late': 'mock:cezar-ask',
} as const;

/** The runners that reject a request with a provider error frame. */
export const PROVIDER_ERROR_MOCK_SCENARIOS = {
  'provider-error': 'mock:provider-error',
  'provider-error-controlled': 'mock:provider-error',
  'post-success-refusal': 'mock:provider-error',
  'steer-late': 'mock:steer-late',
} as const;

/** The runners with a native approval wire. */
export const NATIVE_APPROVAL_MOCK_SCENARIOS = {
  approval: 'mock:approval',
  'approval-resolved': 'mock:approval-resolved',
  'approval-turn-end': 'mock:approval-turn-end',
  'ask-bad': 'mock:ask-bad',
} as const;
