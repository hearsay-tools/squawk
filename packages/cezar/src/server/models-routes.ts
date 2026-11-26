import { Hono } from 'hono';
import { modelDiscoveryQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-contract/agent-profiles';
import { knownRunnerIds, registeredRunnerId } from '../core/runner-registry.ts';
import type { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { queryZodValidator } from './validators.ts';

export function createModelsRoutes(options: {
  resolveWorkspaceProfile(provider: string, profileId?: string): Promise<{ profile: ResolvedAgentProfile } | { error: string }>;
  modelCatalog: RunnerModelCatalog;
}) {
  const { resolveWorkspaceProfile, modelCatalog } = options;
  return new Hono()
    // `modelDiscoveryRunnerSchema` is the contract's own list of the runners with an
    // authoritative host-local catalog (hearsay-tools/cezarion#794), so the client compiles against exactly what this
    // validates, including Claude stream-json discovery (hearsay-tools/cezarion#89).
    .get('/models', queryZodValidator(modelDiscoveryQuerySchema, { message: `runner must be ${knownRunnerIds().slice(0, -1).join(', ')}, or ${knownRunnerIds().at(-1)}`, runners: { ids: ['runner'] } }), async (c) => {
      const query = { data: c.req.valid('query') };
      const runner = registeredRunnerId(query.data.runner);
      if (query.data.profileId === undefined || query.data.profileId === DEFAULT_AGENT_ACCOUNT_ID) {
        return c.json(await modelCatalog.get(runner));
      }
      const resolved = await resolveWorkspaceProfile(runner, query.data.profileId);
      if ('error' in resolved) return c.json({ error: resolved.error }, 400);
      return c.json(await modelCatalog.get(runner, { accountHome: resolved.profile.path }));
    });
}
