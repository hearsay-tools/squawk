import { Hono } from 'hono';
import type { RunnersResponse } from '@open-mercato/cezar-contract/runners';
import { registeredRunners } from '../core/runner-registry.ts';
import type { Home } from '../home/home.ts';
import { createRunnerInstallRoutes } from './runner-install-routes.ts';

/**
 * `GET /api/v1/runners` (spec 2026-11-18-runner-definitions, decision 2): the registered runners in
 * registration order, each with its `display` part, the `suggested` and `retired` model ids of its
 * `models` part and the `agentConfig` of its `configFiles` part. It reads the registry only and
 * never probes a CLI; `GET /api/v1/health` says which CLIs are installed.
 */
export function readRunners(): RunnersResponse {
  return {
    runners: registeredRunners().map(({ id, display, models, configFiles, login, cli, loadBrowserSignIn }) => ({
      id,
      ...display,
      ...(login.loginArgs === null ? { terminalLogin: false } : {}),
      ...(loadBrowserSignIn ? { browserLogin: true } : {}),
      ...(cli.installSource && 'managed' in cli.installSource ? { managedInstall: true as const } : {}),
      models: { suggested: [...models.suggested], retired: [...models.retired] },
      agentConfig: configFiles.agentConfig,
    })),
  };
}

/** The workspace family that answers `GET /runners`. */
export function createRunnersRoutes(options: { home: Home; settingsAdmin(): boolean }) {
  return new Hono()
    .get('/runners', (c) => c.json(readRunners()))
    .route('/', createRunnerInstallRoutes(options));
}
