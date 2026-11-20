import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigSchema } from '@open-mercato/cezar-contract/config-requests';
import { setWorkspaceConfigInputSchema } from '@open-mercato/cezar-contract/workspace';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { jsonZodValidator } from './validators.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

registerBuiltInRunners();

/** The closed enum's refusal of a runner id, recorded on main at 9b5394c4a. */
const ENUM = 'Invalid option: expected one of "claude"|"codex"|"opencode"|"pi"|"omp"';
const step = { id: 'a', name: 'A', prompt: 'x', runner: 'gemini' };

/**
 * A runner id is an open string in the contract (spec 2026-11-18-runner-definitions, decision 1);
 * each request route refuses an id that no runner registered with the status and message the
 * closed enum gave before (hearsay-tools/squawk#3897).
 */
describe('an unknown runner id on each request route', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-unknown-runner-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const send = (method: string, path: string, body?: unknown) => apiRequest(app, path, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

  it.each([
    ['POST', '/api/v1/runs', { task: 't', workflow: 'quick-task', runner: 'gemini' }, `runner: ${ENUM}`],
    ['POST', '/api/v1/runs', { task: 't', steps: [step] }, `steps.0.runner: ${ENUM}`],
    ['POST', '/api/v1/runs/r1/continue', { runner: 'gemini' }, `runner: ${ENUM}`],
    ['POST', '/api/v1/providers/connect', { provider: 'gemini' }, 'provider must be claude, codex, opencode, pi, or omp'],
    ['PUT', '/api/v1/providers/gemini/enabled', { enabled: true }, 'provider and enabled boolean are required'],
    ['POST', '/api/v1/providers/gemini/retry', { authFailureId: 'f1' }, 'provider and current authFailureId are required'],
    ['POST', '/api/v1/workspace/agent-profiles', { provider: 'gemini', configDir: '/x' }, `provider: ${ENUM}`],
    ['PUT', '/api/v1/workspace/agent-profiles/selection', { projectId: 'p', provider: 'gemini', profileId: null }, `provider: ${ENUM}`],
    ['PUT', '/api/v1/workspace/config', { agentDefaults: { runner: 'gemini' } }, `agentDefaults.runner: ${ENUM}`],
    ['PUT', '/api/v1/workspace/ui-state', { dismissedProviderAuthFailures: { gemini: 'x' } }, 'dismissedProviderAuthFailures: Unrecognized key: "gemini"'],
    ['PUT', '/api/v1/config', { defaultRunner: 'gemini' }, `defaultRunner: ${ENUM}`],
    ['GET', '/api/v1/models?runner=gemini', undefined, 'runner must be claude, codex, opencode, pi, or omp'],
    ['GET', '/api/v1/runner-skills?runner=gemini', undefined, `runner: ${ENUM}`],
    ['POST', '/api/v1/workflows', { name: 'w', steps: [step] }, `steps.0.runner: ${ENUM}`],
    ['POST', '/api/v1/automations', { name: 'n', task: { prompt: 'p', runner: 'gemini' } }, `task.runner: ${ENUM}`],
    ['PUT', '/api/v1/automations/a1', { name: 'n', expectedRevision: 1, task: { prompt: 'p', steps: [step] } }, `task.steps.0.runner: ${ENUM}`],
  ] as const)('%s %s refuses it as the closed enum did', async (method, path, body, error) => {
    const response = await send(method, path, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  it('keeps a dismissal of a removed runner, which the ui-state schema listed', async () => {
    const response = await send('PUT', '/api/v1/workspace/ui-state', { dismissedProviderAuthFailures: { cursor: 'x', claude: 'y' } });
    expect(response.status).toBe(200);
  });
});

describe('a per-runner object in a request', () => {
  // The object schemas dropped a key they did not list; the route drops a key that no runner registered.
  it.each([
    ['PUT /config defaultModels', setConfigSchema, ['defaultModels'], { defaultModels: { gemini: 'm', claude: 'opus' } }, { defaultModels: { claude: 'opus' } }],
    ['PUT /workspace/config agentDefaults.models', setWorkspaceConfigInputSchema, ['agentDefaults.models'], { agentDefaults: { models: { gemini: 'm', claude: 'opus' } } }, { agentDefaults: { models: { claude: 'opus' } } }],
  ] as const)('%s drops the key of an unknown runner', async (_route, schema, keys, body, kept) => {
    const app = new Hono().put('/', jsonZodValidator(schema, { runners: { keys } }), (c) => c.json(c.req.valid('json')));
    const response = await app.request('/', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(kept);
  });
});
