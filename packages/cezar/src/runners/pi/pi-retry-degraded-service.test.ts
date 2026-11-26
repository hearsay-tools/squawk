import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function adapt(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const extensionUrl = new URL('./extensions/pi-retry-degraded-service.mjs', import.meta.url);
  const source = `
    import register from ${JSON.stringify(extensionUrl.href)};
    let handler;
    register({ on(type, callback) { if (type === 'message_end') handler = callback; } });
    const event = { message: ${JSON.stringify(message)} };
    process.stdout.write(JSON.stringify(handler(event)?.message ?? null));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' });
  return JSON.parse(output) ?? undefined;
}

describe('pi degraded-service retry adapter (#276)', () => {
  it.each([
    'Error Code null: Service temporarily unavailable. The model\'s availability is currently degraded.',
    "The model's availability is currently degraded.",
  ])('makes the xAI degraded-service wording match pi-ai retry classification: %s', (errorMessage) => {
    expect(adapt({ role: 'assistant', provider: 'xai', stopReason: 'error', errorMessage })).toMatchObject({
      errorMessage: `[cezar:retry-xai-degraded] Service unavailable: ${errorMessage}`,
    });
  });

  it.each(['cliproxy-grok', 'openai'])('makes a stream closed without finish_reason match pi-ai retry classification: %s', (provider) => {
    const errorMessage = 'upstream stream closed before any chunk carried finish_reason';
    expect(adapt({ role: 'assistant', provider, stopReason: 'error', errorMessage })).toMatchObject({
      errorMessage: `[cezar:retry-stream-closed] stream was interrupted: ${errorMessage}`,
    });
  });

  it.each([
    { role: 'assistant', provider: 'xai', stopReason: 'error', errorMessage: 'Internal error during token generation' },
    { role: 'assistant', provider: 'cliproxy-grok', stopReason: 'end_turn', errorMessage: 'upstream stream closed before any chunk carried finish_reason' },
    { role: 'assistant', provider: 'openai', stopReason: 'error', errorMessage: 'Service temporarily unavailable' },
    { role: 'assistant', provider: 'xai', stopReason: 'end_turn', errorMessage: 'Service temporarily unavailable' },
  ])('leaves non-target provider messages unchanged: %j', (message) => {
    expect(adapt(message)).toBeUndefined();
  });
});
