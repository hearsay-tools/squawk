// Each rule prefixes a provider error that pi-ai does not classify as retryable with a hint
// that it does. pi-runner.ts strips the same hints before any reader sees the error.
const RULES = [
  {
    hint: '[cezar:retry-xai-degraded] Service unavailable: ',
    applies: (message) => message.provider === 'xai',
    error: /service temporarily unavailable|availability is currently degraded/i,
  },
  {
    hint: '[cezar:retry-stream-closed] stream was interrupted: ',
    applies: () => true,
    error: /stream closed before any chunk carried finish_reason/i,
  },
];

export default function registerPiDegradedServiceRetry(pi) {
  pi.on('message_end', (event) => {
    const message = event.message;
    if (message?.role !== 'assistant' || message.stopReason !== 'error') return;
    if (typeof message.errorMessage !== 'string') return;

    const rule = RULES.find((candidate) => candidate.applies(message) && candidate.error.test(message.errorMessage));
    if (!rule) return;
    return { message: { ...message, errorMessage: `${rule.hint}${message.errorMessage}` } };
  });
}
