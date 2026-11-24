import type { ProviderCommandResult, ProviderConnectionState } from '../../core/provider-auth.ts';
import { normalizedLines } from '../../core/login-output.ts';

/** Pi's auth-status parser, moved verbatim from `core/provider-auth.ts`. Loads only through
 *  the definition's `loadLogin()`. */
export function parsePiStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  if (result.exitCode !== 0) return null;
  const lines = normalizedLines(result.stdout);
  if (lines.some((line) => /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/.test(line))) {
    return 'connected';
  }
  if (
    lines.some((line) => line.includes('no models available'))
    && lines.some((line) => line.includes('/login'))
  ) {
    return 'disconnected';
  }
  return null;
}
