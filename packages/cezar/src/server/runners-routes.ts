import { Hono } from 'hono';
import type { RunnersResponse } from '@open-mercato/cezar-contract/runners';
import { registeredRunners } from '../core/runner-registry.ts';

/**
 * `GET /api/v1/runners` (spec 2026-11-18-runner-definitions, decision 2): the registered runners in
 * registration order, each with its `display` part. It reads the registry only and never probes a
 * CLI; `GET /api/v1/health` says which CLIs are installed.
 */
export function readRunners(): RunnersResponse {
  return { runners: registeredRunners().map(({ id, display }) => ({ id, ...display })) };
}

/** The workspace family that answers `GET /runners`. */
export function createRunnersRoutes() {
  return new Hono().get('/runners', (c) => c.json(readRunners()));
}
