/**
 * The redaction topic of the run store (hearsay-tools/squawk#4040): the scrub of events and free
 * text before they reach disk or the live wire. `RunStore` keeps one of these as `store.redaction`.
 */
import { productEnv } from '../core/product-env.ts';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import type { RunRedaction as RunRedactionPort } from './ports.ts';
import { redactText } from './record-write-rules.ts';
import type { RunEvent } from './store.ts';

export class RunRedaction implements RunRedactionPort {
  /** Lazily-collected concrete secret values from the host env (#427). */
  private secretValues: readonly string[] | null = null;
  /** Controller-issued tokens never persist, including when host-secret redaction is disabled. */
  private readonly sessionSecrets = new Set<string>();
  registerSessionSecret(value: string): void { this.sessionSecrets.add(value); }
  containsSessionSecret(value: string): boolean { return [...this.sessionSecrets].some(secret => value.includes(secret)); }

  /**
   * Scrub known credential values / token shapes from an event before it is
   * persisted or fanned out. On by default; `CEZ_REDACT_SECRETS=0` opts out.
   */
  redact<T extends RunEvent>(event: T): T {
    const safe = this.sessionSecrets.size ? redactDeep(event, [...this.sessionSecrets]) : event;
    if (productEnv('REDACT_SECRETS') === '0') return safe;
    return redactDeep(safe, this.hostSecrets());
  }

  /** Best-effort scrub of one free-text string bound for `runs.json`. Honors
   *  the `CEZ_REDACT_SECRETS=0` opt-out itself so every caller inherits it. */
  redactText(text: string): string {
    return redactText(text, [...this.sessionSecrets], () => this.hostSecrets());
  }

  private hostSecrets(): readonly string[] {
    if (this.secretValues === null) this.secretValues = collectSecretValues();
    return this.secretValues;
  }
}
