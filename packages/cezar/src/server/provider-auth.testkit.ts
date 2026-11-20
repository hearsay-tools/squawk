import { ProviderAuthService, type ProviderStatusResponse } from '../core/provider-auth.ts';
import { registeredRunners } from '../core/runner-registry.ts';

class ConnectedProviderAuthService extends ProviderAuthService {
  override status(): Promise<ProviderStatusResponse> {
    return Promise.resolve({
      providers: registeredRunners().map(({ id: provider }) => ({ provider, status: 'connected' })),
    });
  }
}

/** Deterministic provider discovery for route tests whose subject is not auth gating. */
export function connectedProviderAuth(): ProviderAuthService {
  return new ConnectedProviderAuthService();
}
