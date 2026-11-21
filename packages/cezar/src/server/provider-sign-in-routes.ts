import { Hono } from 'hono';
import { providerConnectSchema, providerSignInParamsSchema, providerSignInRedirectSchema } from '@open-mercato/cezar-contract/provider-requests';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-contract/agent-profiles';
import { registeredRunnerId, runnerDefinition } from '../core/runner-registry.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import type { ProviderAuthService } from '../core/provider-auth.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';
import { ProviderSignIns } from './provider-sign-ins.ts';

export function createProviderSignInRoutes(options: {
  localHandoff(): boolean;
  resolve(provider: string, profileId?: string): Promise<{ profile: ResolvedAgentProfile } | { error: string }>;
  auth: ProviderAuthService;
  invalidateModels(provider: string): void;
  signIns?: ProviderSignIns;
}) {
  const signIns = options.signIns ?? new ProviderSignIns();
  return new Hono()
    .use('/providers/sign-in/*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      if (!options.localHandoff()) return c.json({ error: 'Sign-in is available only on the machine hosting Squawk.' }, 409);
      await next();
    })
    .post('/providers/sign-in/start', jsonZodValidator(providerConnectSchema, { runners: { ids: ['provider'] } }), async c => {
      const body = c.req.valid('json');
      const provider = registeredRunnerId(body.provider);
      const loader = runnerDefinition(provider).loadBrowserSignIn;
      if (!loader) return c.json({ error: 'This runner has no browser sign-in flow.' }, 409);
      const resolved = await options.resolve(provider, body.profileId);
      if ('error' in resolved) return c.json({ error: resolved.error }, 400);
      const profile = resolved.profile;
      try {
        const result = await signIns.start(JSON.stringify([provider, profile.id, profile.path]),
          async () => (await loader())(profile.isDefault ? undefined : profile.path),
          async () => {
            options.auth.forgetProfileStatus(provider, profile.id);
            options.invalidateModels(provider);
            if (profile.id === DEFAULT_AGENT_ACCOUNT_ID) await options.auth.status({ refresh: true });
            else await options.auth.profileStatus(provider, { id: profile.id, configDir: profile.path });
          });
        return c.json(result);
      } catch { return c.json({ error: 'Browser sign-in could not start. Check the installation and try again.' }, 409); }
    })
    .get('/providers/sign-in/:id', paramZodValidator(providerSignInParamsSchema), c => {
      const result = signIns.get(c.req.valid('param').id);
      return result ? c.json(result) : c.json({ error: 'Sign-in expired. Start a new sign-in.' }, 404);
    })
    .post('/providers/sign-in/:id/redirect', paramZodValidator(providerSignInParamsSchema), jsonZodValidator(providerSignInRedirectSchema), async c => {
      try {
        const result = await signIns.redirect(c.req.valid('param').id, c.req.valid('json').redirectUrl);
        return result ? c.json(result) : c.json({ error: 'Sign-in expired. Start a new sign-in.' }, 404);
      } catch { return c.json({ error: 'The redirect could not be accepted. Paste the complete URL from this sign-in, or start a new sign-in.' }, 409); }
    })
    .delete('/providers/sign-in/:id', paramZodValidator(providerSignInParamsSchema), async c => {
      const result = await signIns.cancel(c.req.valid('param').id);
      return result ? c.json(result) : c.json({ error: 'Sign-in expired. Start a new sign-in.' }, 404);
    });
}
