import {
  providerAuthChecksDisabled,
  type ProviderId,
  type ProviderStatus,
  type ProviderStatusResponse,
} from './provider-auth.ts';
import type { ProviderStatusResponse as WireProviderStatusResponse } from '@open-mercato/cezar-contract/workspace';

/** The discovered rows with each one's enablement, as the wire sends them: runner ids are strings. */
export function applyProviderEnablement(
  response: ProviderStatusResponse,
  disabledProviders: readonly ProviderId[],
): WireProviderStatusResponse {
  const disabled = new Set(
    providerAuthChecksDisabled() ? [] : disabledProviders,
  );
  return {
    providers: response.providers.map((row) => ({
      ...row,
      enabled: !disabled.has(row.provider),
    })),
  };
}

export function isProviderUsable(row: ProviderStatus): boolean {
  return row.enabled !== false && row.status === 'connected';
}
