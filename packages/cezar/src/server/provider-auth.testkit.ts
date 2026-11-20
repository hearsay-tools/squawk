import { ProviderAuthService, type ProviderStatusResponse } from '../core/provider-auth.ts';
import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';

class ConnectedProviderAuthService extends ProviderAuthService {
  override status(): Promise<ProviderStatusResponse> {
    return Promise.resolve({
      providers: BUILT_IN_RUNNER_IDS.map(provider => ({ provider, status: 'connected' })),
    });
  }
}

/** Deterministic provider discovery for route tests whose subject is not auth gating. */
export function connectedProviderAuth(): ProviderAuthService {
  return new ConnectedProviderAuthService();
}
