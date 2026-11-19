/**
 * One gate for the GitHub requests of the three pollers: the PR wait, automations and
 * archive-on-merge (hearsay-tools/squawk#3127). It holds one concurrency limit for all of them, and
 * a rate-limit reply to any of them pauses all of them. Each poller keeps its own interval, owner
 * and storage. The gate needs no setting.
 */

/** How many poller requests run at once, process-wide. */
export const GITHUB_REQUEST_LIMIT = 4;
/** The first pause after a rate-limit reply. Each further reply doubles it, up to the maximum. */
export const GITHUB_PAUSE_MIN_MS = 60_000;
export const GITHUB_PAUSE_MAX_MS = 15 * 60_000;

/**
 * A rate-limit reply: HTTP 429, or GitHub's `rate limit` text. gh prints the primary limit as
 * `HTTP 403: API rate limit exceeded` and the secondary one as `... secondary rate limit`. A plain
 * 403 is an access error, not a rate limit.
 */
export function isGithubRateLimit(text: string): boolean {
  return /rate.?limit|\b429\b/i.test(text);
}

/** GitHub rate-limited the pollers. No request runs before `until` (epoch milliseconds). */
export class GithubRateLimitedError extends Error {
  constructor(readonly until: number, options?: ErrorOptions) {
    super(`GitHub rate limit; next request after ${new Date(until).toISOString()}.`, options);
  }
}

/** FIFO permits; aborted queued requests never consume a slot. */
export class RequestPermits {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const i = this.queue.indexOf(ready); if (i >= 0) this.queue.splice(i, 1); reject(signal.reason); };
      this.queue.push(ready); signal.addEventListener('abort', abort, { once: true });
    });
    else this.active++;
    // A slot is transferred to the oldest waiter, not released and raced for.
    if (signal.aborted) { this.release(); signal.throwIfAborted(); }
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  private release(): void { const next = this.queue.shift(); if (next) next(); else this.active--; }
}

export interface GithubAdmission {
  signal?: AbortSignal | undefined;
  /** False: the request takes no permit (a long `--watch`, or a progress read its caller bounds). */
  permit?: boolean;
  /** `wait` sleeps until the pause ends; `throw` refuses at once with `GithubRateLimitedError`. */
  whenPaused?: 'wait' | 'throw';
}

const never = new AbortController().signal;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The stderr of a failed child process, never its message: the message repeats the command line. */
function failureText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : '';
}

export class GithubRequestGate {
  private readonly permits: RequestPermits;
  private readonly now: () => number;
  private until = 0;
  private nextPause = GITHUB_PAUSE_MIN_MS;

  constructor(options: { limit?: number; now?: () => number } = {}) {
    this.permits = new RequestPermits(options.limit ?? GITHUB_REQUEST_LIMIT);
    this.now = options.now ?? (() => Date.now());
  }

  /** The end of the current pause in epoch milliseconds, or undefined when no pause holds. */
  pausedUntil(): number | undefined {
    return this.until > this.now() ? this.until : undefined;
  }

  /** Wait out any pause, then take a permit. The returned function releases it. */
  async admit(options: GithubAdmission = {}): Promise<() => void> {
    const signal = options.signal ?? never;
    for (;;) {
      await this.waitOutPause(signal, options.whenPaused ?? 'wait');
      const release = options.permit === false ? () => undefined : await this.permits.acquire(signal);
      // A pause can start while this request waits in the queue.
      if (this.pausedUntil() === undefined) return release;
      release();
    }
  }

  /** Record one reply. A rate limit starts or extends the pause for every poller; any other reply ends the escalation. */
  record(rateLimited: boolean): void {
    if (!rateLimited) { this.nextPause = GITHUB_PAUSE_MIN_MS; return; }
    // Replies to requests that were already in flight when the pause began do not extend it again.
    if (this.pausedUntil() !== undefined) return;
    this.until = this.now() + this.nextPause;
    this.nextPause = Math.min(GITHUB_PAUSE_MAX_MS, this.nextPause * 2);
  }

  /**
   * Run one request under the gate. A thrown error whose stderr is a rate-limit reply becomes
   * `GithubRateLimitedError`; `rateLimited` classifies a reply the request returns instead of throwing.
   */
  async run<T>(request: () => Promise<T>, options: GithubAdmission & { rateLimited?: (reply: T) => boolean } = {}): Promise<T> {
    const release = await this.admit(options);
    try {
      let reply: T;
      try { reply = await request(); } catch (error) {
        if (!isGithubRateLimit(failureText(error))) { this.record(false); throw error; }
        this.record(true);
        throw new GithubRateLimitedError(this.until, { cause: error });
      }
      this.record(options.rateLimited?.(reply) ?? false);
      return reply;
    } finally { release(); }
  }

  private async waitOutPause(signal: AbortSignal, whenPaused: 'wait' | 'throw'): Promise<void> {
    for (let until = this.pausedUntil(); until !== undefined; until = this.pausedUntil()) {
      if (whenPaused === 'throw') throw new GithubRateLimitedError(until);
      await sleep(until - this.now(), signal);
    }
  }
}

/** The process-wide gate the three pollers share. */
export const githubRequestGate = new GithubRequestGate();
