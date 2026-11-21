import { collectSecretValues, redactSecrets } from './secret-redaction.ts';

/** Keep full diagnostic detail while removing OAuth URLs and credential values. */
export function redactBrowserSignInDetails(message: string): string {
  return redactSecrets(message, collectSecretValues())
      .replace(/https?:\/\/[^\s<>"']+/gi, '[URL redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(access_token|refresh_token|id_token|client_secret|token|code|state|authorization)["']?\s*[:=]\s*["']?[^\s,"'}]+/gi, '$1=[redacted]');
}

/** A startup error whose message may cross the browser sign-in HTTP boundary. */
export class BrowserSignInStartError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    const safe = redactBrowserSignInDetails(message).replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 320);
    super(safe, options);
  }
}
