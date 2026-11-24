import { Hono } from 'hono';
import { runnerInstallParamsSchema, runnerInstallActionSchema } from '@open-mercato/cezar-contract/runner-install';
import type { Home } from '../home/home.ts';
import type { ManagedCliSource } from '../core/managed-cli-source.ts';
import { runnerDefinition } from '../core/runner-registry.ts';
import { ManagedCliInstallation } from '../managed-install/cli-installation.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';

export function createRunnerInstallRoutes(options: {
  home: Home;
  settingsAdmin(): boolean;
  create?: (runner: string, source: ManagedCliSource) => ManagedCliInstallation;
}) {
  const installations = new Map<string, ManagedCliInstallation>();
  const installation = (runner: string) => {
    const existing = installations.get(runner);
    if (existing) return existing;
    const source = runnerDefinition(runner).cli.installSource;
    if (!source || !('managed' in source)) return null;
    const created = options.create?.(runner, source.managed) ?? new ManagedCliInstallation(options.home, runner, source.managed);
    installations.set(runner, created);
    return created;
  };
  const params = () => paramZodValidator(runnerInstallParamsSchema, { runners: { ids: ['runner'] } });
  return new Hono()
    .use('/runner-install/*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      if (!options.settingsAdmin()) return c.json({ error: 'CLI installation is disabled on this remote cockpit. Run `hsq remote-settings enable` on the host to allow it.' }, 409);
      await next();
    })
    .get('/runner-install/:runner', params(), c => {
      const managed = installation(c.req.valid('param').runner);
      if (!managed) return c.json({ error: 'This runner has no managed CLI installation.' }, 409);
      try {
        managed.refreshIfDue();
        return c.json(managed.status());
      } catch { return c.json({ error: 'The managed CLI installation could not be read.' }, 409); }
    })
    .post('/runner-install/:runner', params(), jsonZodValidator(runnerInstallActionSchema), c => {
      const managed = installation(c.req.valid('param').runner);
      if (!managed) return c.json({ error: 'This runner has no managed CLI installation.' }, 409);
      try {
        managed.start(c.req.valid('json').action);
        return c.json(managed.status(), 202);
      } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'The CLI operation could not start.' }, 409); }
    });
}
