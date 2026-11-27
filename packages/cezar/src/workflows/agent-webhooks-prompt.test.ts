import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';
import { webhooksLaunchPart } from '../built-in-launch-parts.ts';

const HEADING = '## Project webhooks';
const COCKPIT_ORIGIN = 'http://127.0.0.1:5555';

/**
 * The "Project webhooks" part (hearsay-tools/cezarion#1576): an addressed manager lists the
 * webhooks its project exposes to agents; nothing exposed, or no cockpit to send through,
 * composes nothing. Both session construction sites take this launch part through the shared
 * `launchSystemTail`; launch-system-prompt.test.ts pins the whole prompt at both sites.
 */
describe('agent webhooks prompt part (#1576)', () => {
  let repoRoot: string;
  let projectId: string;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-webhooks-prompt-'));
    projectId = (await registerProject(repoRoot, undefined, testHome())).id;
  });

  afterEach(async () => {
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = config.projects.filter((project) => project.id !== projectId);
    }, testHome());
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const setWebhooks = (webhooks: Array<{ id: string; name: string; description?: string; agent: boolean }>) =>
    mergeWriteWorkspaceConfig((config) => {
      config.projects.find((project) => project.id === projectId)!.webhooks = webhooks.map((webhook) => ({
        ...webhook, url: `https://${webhook.id}.example/hook`, token: 'never-in-a-prompt', tasks: false,
      }));
    }, testHome());

  /** The part a session launch composes, for a manager with this cockpit address. */
  const part = async (cockpit: { origin: string; projectId: string } | undefined) =>
    (await webhooksLaunchPart.contribute({ runId: 'webhooks-run', dataDir: repoRoot, repoRoot, home: testHome(), cockpit, env: {} }))?.prompt;

  it('lists the exposed webhooks by name and description, with the send command', async () => {
    await setWebhooks([
      { id: 'friction', name: 'Friction reports', description: 'Friction you hit with tools.\nNot GitHub issues.', agent: true },
      { id: 'tasks', name: 'Task bot', agent: false },
    ]);
    const prompt = await part({ origin: COCKPIT_ORIGIN, projectId });
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain('- "Friction reports": Friction you hit with tools. Not GitHub issues.');
    expect(prompt).toContain(' webhook send ');
    expect(prompt).not.toContain('Task bot');
    expect(prompt).not.toContain('friction.example');
    expect(prompt).not.toContain('never-in-a-prompt');
  });

  it('composes nothing when no webhook is exposed to agents', async () => {
    await setWebhooks([{ id: 'tasks', name: 'Task bot', agent: false }]);
    expect(await part({ origin: COCKPIT_ORIGIN, projectId }) ?? '').not.toContain(HEADING);
  });

  it('composes nothing without a cockpit to send through (headless `cez run`)', async () => {
    await setWebhooks([{ id: 'friction', name: 'Friction reports', agent: true }]);
    expect(await part(undefined) ?? '').not.toContain(HEADING);
  });
});
