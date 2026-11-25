import { isRecord } from '@hearsay-tools/squawk/plugin/pi-rpc';

/** The prefix scripts/pi-runaway-reply-guard.mjs puts on a reply it stopped. */
const RUNAWAY_REPLY_MARKER = '[cezar:runaway-reply] ';

/** What the model reads after Squawk stopped its reply (hearsay-tools/squawk#4236). */
export const RUNAWAY_REPLY_RETRY_PROMPT =
  'Squawk stopped your last reply because it passed 64 KiB of text, which usually means repeated output. '
  + 'Continue the task from where you were. Do not repeat earlier text.';

export const RUNAWAY_REPLY_RETRY_NOTE =
  'pi: stopped a runaway reply (over 64 KiB of text in one message) and asked the model to continue (retry 1 of 1)';

const RUNAWAY_REPLY_FAILURE = 'Squawk stopped a runaway reply twice (over 64 KiB of text in one message)';

/** The id of the retry prompt, so its ack is not read as a human prompt's. */
export const RUNAWAY_REPLY_RETRY_ID = 'cezar-runaway-retry';

/**
 * One retry per turn for a reply the guard extension stopped. pi cannot continue a run after an
 * abort, so the runner keeps the turn open at `agent_settled` and prompts the same session again.
 * A second stopped reply in the same turn keeps its error, and the turn fails as any provider
 * error does.
 */
export class PiRunawayReplyRetry {
  private retried = false;
  private retryPending = false;

  /**
   * Reads a native message before anyone else does. A stopped reply's `message_end` is rewritten
   * in place: the first in a turn becomes a plain aborted reply, so no error is latched; a later
   * one carries the failure text. Returns true when it scheduled the retry.
   */
  readMessage(value: Record<string, unknown>): boolean {
    if (value.type !== 'message_end' || !isRecord(value.message)) return false;
    const message = value.message;
    if (message.role !== 'assistant' || typeof message.errorMessage !== 'string') return false;
    if (!message.errorMessage.startsWith(RUNAWAY_REPLY_MARKER)) return false;
    if (this.retried) {
      message.errorMessage = RUNAWAY_REPLY_FAILURE;
      return false;
    }
    this.retried = true;
    this.retryPending = true;
    message.stopReason = 'aborted';
    delete message.errorMessage;
    return true;
  }

  /** At `agent_settled`: true when the turn stays open for the retry prompt. */
  takeRetry(): boolean {
    const pending = this.retryPending;
    this.retryPending = false;
    return pending;
  }

  /** The turn settled: the next turn gets its own retry. */
  turnSettled(): void {
    this.retried = false;
    this.retryPending = false;
  }
}
