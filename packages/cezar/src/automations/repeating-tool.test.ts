import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationToolRequestSchema } from '@open-mercato/cezar-contract/automation-tool';
import { testHome } from '../home/test-home.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createAutomationService, type AutomationServiceProject } from './service.ts';
import { AutomationStore } from './store.ts';
import { createAutomationToolService } from './tool-adapter.ts';
import type { GithubPoller } from './github-poller.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const definition = { name: 'Review issues', kind: 'github' as const, events: ['issue.opened' as const], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'squawk-repeating-')); dirs.push(root);
  const project: AutomationServiceProject = {
    id: 'project', root, automationStore: AutomationStore.open(join(root, 'automations')),
    store: RunStore.open(join(root, 'runs')),
    manager: { cockpitAddress: () => ({ origin: 'http://localhost:8080', projectId: 'project' }), startRun: vi.fn() } as unknown as AutomationServiceProject['manager'],
  };
  const service = createAutomationService({ home: testHome(), timeZone: () => 'UTC',
    scheduleHandle: () => ({ projectId: project.id, store: project.automationStore, timeZone: 'UTC' }),
    emitChange: () => {}, changed: () => {}, githubAvailability: async () => ({ available: true }), hasGithubRemote: async () => true,
  });
  const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
  const tools = createAutomationToolService(service, project, { timeZone: () => 'UTC', github: async () => ({ owner: 'owner', repo: 'repo', poller: { poll } as unknown as GithubPoller }) });
  const session = new AbortController();
  const create = () => tools.automation({ action: 'create', definition }, session.signal);
  return { project, service, tools, session, create, poll };
}

describe('repeating automation tool', () => {
  it('creates paused, shows its prompt and URL, and previews without launches or receipts', async () => {
    const { tools, project, session, create, poll } = fixture();
    const made = await create();
    expect(made).toMatchObject({ ok: true, automation: { enabled: false, task: { prompt: definition.task.prompt, autonomous: true, worktree: true } }, url: expect.stringContaining('/p/project/automations/') });
    if (!made.ok) throw new Error(made.message);
    expect(await tools.automation({ action: 'show', id: made.automation.id }, session.signal)).toMatchObject({ ok: true, automation: { id: made.automation.id, enabled: false } });
    expect(await tools.automation({ action: 'preview', id: made.automation.id }, session.signal)).toMatchObject({ ok: true, preview: { matches: 0, truncated: false } });
    expect(poll).toHaveBeenCalledOnce();
    expect(project.manager.startRun).not.toHaveBeenCalled();
    expect(project.automationStore.receipts()).toEqual([]);
    expect(await tools.automation({ action: 'enable', id: made.automation.id, explicit: true }, session.signal)).toMatchObject({ ok: true, automation: { enabled: true } });
  });

  it('refuses enable without explicit true, even after preview', async () => {
    const { tools, session, create } = fixture(); const made = await create();
    if (!made.ok) throw new Error(made.message);
    await tools.automation({ action: 'preview', id: made.automation.id }, session.signal);
    for (const explicit of [undefined, false]) expect(await tools.automation({ action: 'enable', id: made.automation.id, explicit }, session.signal)).toMatchObject({ ok: false, code: 'explicit_required' });
  });

  it('refuses a poll enable without a successful preview in the calling session', async () => {
    const { tools, session, create } = fixture(); const made = await create();
    if (!made.ok) throw new Error(made.message);
    const enable = { action: 'enable' as const, id: made.automation.id, explicit: true };
    expect(await tools.automation(enable, session.signal)).toMatchObject({ ok: false, code: 'preview_required' });
    await tools.automation({ action: 'preview', id: made.automation.id }, session.signal);
    expect(await tools.automation(enable, new AbortController().signal)).toMatchObject({ ok: false, code: 'preview_required' });
  });

  it('does not accept a failed or obsolete preview', async () => {
    const { tools, session, create, poll, service, project } = fixture(); const made = await create();
    if (!made.ok) throw new Error(made.message);
    const id = made.automation.id;
    poll.mockRejectedValueOnce(new Error('GitHub unavailable'));
    expect(await tools.automation({ action: 'preview', id }, session.signal)).toMatchObject({ ok: false, message: 'GitHub unavailable' });
    expect(await tools.automation({ action: 'enable', id, explicit: true }, session.signal)).toMatchObject({ code: 'preview_required' });
    await tools.automation({ action: 'preview', id }, session.signal);
    await service.update(project, id, { ...definition, expectedRevision: made.automation.revision, task: { prompt: 'Changed' } });
    expect(await tools.automation({ action: 'enable', id, explicit: true }, session.signal)).toMatchObject({ code: 'preview_required' });
  });

  it('creates a repeating schedule paused, reports its next occurrence and enables only explicitly', async () => {
    const { tools, session } = fixture();
    const made = await tools.automation({ action: 'create', definition: { name: 'Daily', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Check it' } } }, session.signal);
    expect(made).toMatchObject({ ok: true, automation: { enabled: false }, next_run_at: expect.stringMatching(/Z$/) });
    if (!made.ok) throw new Error(made.message);
    expect(await tools.automation({ action: 'enable', id: made.automation.id }, session.signal)).toMatchObject({ code: 'explicit_required' });
    expect(await tools.automation({ action: 'enable', id: made.automation.id, explicit: true }, session.signal)).toMatchObject({ ok: true, automation: { enabled: true } });
  });

  it('refuses enable fields on creation and directs one-time schedules to their existing tools', async () => {
    for (const extra of [{ enable: true }, { enabled: true }]) expect(automationToolRequestSchema.safeParse({ action: 'create', definition: { ...definition, ...extra } }).success).toBe(false);
    const { tools, project, session } = fixture();
    const once = project.automationStore.create({ name: 'Once', kind: 'schedule', enabled: false, schedule: { type: 'once', at: '2030-01-01T10:00', timeZone: 'UTC' }, task: { prompt: 'Check' } });
    expect(await tools.automation({ action: 'show', id: once.id }, session.signal)).toMatchObject({ ok: false, code: 'not_found' });
    expect(automationToolRequestSchema.safeParse({ action: 'create', definition: { name: 'Once', kind: 'schedule', schedule: once.schedule, task: { prompt: 'Check' } } }).success).toBe(false);
  });
});
