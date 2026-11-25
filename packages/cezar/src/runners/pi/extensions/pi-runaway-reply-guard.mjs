// Stops an assistant reply whose streamed text passes the limit: a model stuck repeating itself
// streams megabytes into one message and sends Squawk no event for most of an hour
// (hearsay-tools/squawk#4236). pi does not retry or continue a run after an abort, so the stopped
// message ends as a marked error and pi-runner.ts sends the one retry prompt. Thinking text is not
// counted: long reasoning is legitimate, and no loop was observed there.
const LIMIT_BYTES = 64 * 1024;
const MARKER = '[cezar:runaway-reply] ';

export default function registerPiRunawayReplyGuard(pi) {
  let textBytes = 0;
  let stopped = false;

  pi.on('message_start', (event) => {
    if (event.message?.role !== 'assistant') return;
    textBytes = 0;
    stopped = false;
  });

  pi.on('message_update', (event, ctx) => {
    const update = event.assistantMessageEvent;
    if (stopped || update?.type !== 'text_delta' || typeof update.delta !== 'string') return;
    textBytes += Buffer.byteLength(update.delta, 'utf8');
    if (textBytes <= LIMIT_BYTES) return;
    stopped = true;
    ctx.abort();
  });

  pi.on('message_end', (event) => {
    const message = event.message;
    if (!stopped || message?.role !== 'assistant') return;
    stopped = false;
    return { message: { ...message, stopReason: 'error', errorMessage: `${MARKER}the reply passed 64 KiB of text in one message` } };
  });
}
