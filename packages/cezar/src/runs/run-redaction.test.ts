import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSecretValues, redactDeep, REDACTED } from '../core/secret-redaction.ts';
import { RunRedaction } from './run-redaction.ts';
import type { RunEvent } from './store.ts';

const SESSION = 'cez-session-secret-0123456789';
const HOST = `host-${SESSION}-suffix`;
const GH = `ghp_${'a'.repeat(40)}`;

function event(text: string): RunEvent {
  return { type: 'tool', seq: 1, ts: '2026-11-22T00:00:00.000Z', input: { command: text }, output: [text, 7, null] } as unknown as RunEvent;
}

describe('RunRedaction.redact', () => {
  beforeEach(() => {
    vi.stubEnv('P4B_TEST_TOKEN', HOST);
    vi.stubEnv('HSQ_REDACT_SECRETS', '1');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('gives the output of the session scrub followed by the host scrub', () => {
    const redaction = new RunRedaction();
    redaction.registerSessionSecret(SESSION);
    const input = event(`a ${HOST} b ${SESSION} c AIzaab${GH}`);
    const expected = redactDeep(redactDeep(input, [SESSION]), collectSecretValues());
    expect(redaction.redact(input)).toEqual(expected);
    expect(JSON.stringify(redaction.redact(input))).not.toContain(SESSION);
  });

  it('scrubs a session secret registered after an earlier redact', () => {
    const redaction = new RunRedaction();
    const later = 'cez-later-session-secret-987654';
    expect(redaction.redact(event(later))).toEqual(event(later));
    redaction.registerSessionSecret(later);
    expect(redaction.redact(event(later))).toEqual(event(REDACTED));
    expect(redaction.containsSessionSecret(`x${later}x`)).toBe(true);
  });

  it('still scrubs session secrets when host redaction is off', () => {
    vi.stubEnv('HSQ_REDACT_SECRETS', '0');
    const redaction = new RunRedaction();
    redaction.registerSessionSecret(SESSION);
    expect(redaction.redact(event(`${SESSION} ${GH}`))).toEqual(event(`${REDACTED} ${REDACTED}`));
    expect(redaction.redact(event(HOST))).toEqual(event(`host-${REDACTED}-suffix`));
  });

  it('returns a copy, never the input objects', () => {
    const redaction = new RunRedaction();
    redaction.registerSessionSecret(SESSION);
    const input = event('plain text');
    const out = redaction.redact(input) as unknown as { input: object; output: unknown[] };
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out.input).not.toBe((input as unknown as { input: object }).input);
  });
});
