/**
 * The redaction topic of the run store (hearsay-tools/squawk#4040): the scrub of events and free
 * text before they reach disk or the live wire. `RunStore` keeps one of these as `store.redaction`.
 */
import { productEnv } from '../core/product-env.ts';
import { activeMcpSecretValues, collectSecretValues, redactDeep, redactDeepWith, redactSecrets } from '../core/secret-redaction.ts';
import type { RunRedaction as RunRedactionPort } from './ports.ts';
import { redactText } from './record-write-rules.ts';
import type { RunEvent } from './store.ts';

export class RunRedaction implements RunRedactionPort {
  /** Lazily-collected concrete secret values from the host env (#427). */
  private secretValues: readonly string[] | null = null;
  /** Controller-issued tokens never persist, including when host-secret redaction is disabled. */
  private readonly sessionSecrets = new Set<string>();
  /** `sessionSecrets` in insertion order; rebuilt only when a new secret is registered. */
  private sessionList: readonly string[] = [];
  registerSessionSecret(value: string): void {
    if (this.sessionSecrets.has(value)) return;
    this.sessionSecrets.add(value);
    this.sessionList = [...this.sessionSecrets];
  }
  containsSessionSecret(value: string): boolean { return this.sessionList.some(secret => value.includes(secret)); }

  private mandatorySecrets(): readonly string[] {
    const mcp = activeMcpSecretValues();
    if (mcp.length === 0) return this.sessionList;
    if (this.sessionList.length === 0) return mcp;
    return [...new Set([...this.sessionList, ...mcp])].sort((a, b) => b.length - a.length);
  }

  /**
   * Scrub known credential values / token shapes from an event before it is
   * persisted or fanned out. On by default; `CEZ_REDACT_SECRETS=0` opts out.
   */
  redact<T extends RunEvent>(event: T): T {
    const mandatory = this.mandatorySecrets();
    if (productEnv('REDACT_SECRETS') === '0') return mandatory.length ? redactDeep(event, mandatory) : event;
    const host = this.hostSecrets();
    if (!mandatory.length) return redactDeep(event, host);
    // One copy for both scrubs; each string leaf gets the same two passes in the same order.
    return redactDeepWith(event, text => redactSecrets(redactSecrets(text, mandatory), host));
  }

  /** Best-effort scrub of one free-text string bound for `runs.json`. Honors
   *  the `CEZ_REDACT_SECRETS=0` opt-out itself so every caller inherits it. */
  redactText(text: string): string {
    return redactText(text, this.mandatorySecrets(), () => this.hostSecrets());
  }

  private hostSecrets(): readonly string[] {
    if (this.secretValues === null) this.secretValues = collectSecretValues();
    return this.secretValues;
  }
}
