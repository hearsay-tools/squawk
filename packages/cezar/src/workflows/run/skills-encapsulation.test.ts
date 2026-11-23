import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { codexRunner } from '../../runners/codex/definition.ts';

// The skill catalog the fixture builds covers the registered runners; this test reads codex's.

sealTestRunners(codexRunner);
import { testHome } from '../../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunnerSkill } from '@open-mercato/cezar-contract/runner-skills';
import { fixedSkillCatalog } from '../../core/runner-skill-fixture.testkit.ts';
import { RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun } from '../active-run.ts';
import { RunSkills } from './run-skills.ts';
import { TrackedWork } from './tracked-work.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';

let root: string;
let store: RunStore;
let owner: RunSkills;
const entry: RunnerSkill = { id: 'demo', name: 'Demo', scope: 'repo', path: '/skills/demo/SKILL.md' };
let catalog: ReturnType<typeof fixedSkillCatalog>;
const profile = { env: {}, profileId: 'work', accountBinding: { provider: 'codex' as const, profileId: 'work', homePath: '/account' } };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-skill-owner-'));
  store = RunStore.open(root);
  catalog = fixedSkillCatalog([entry]);
  owner = new RunSkills({ skillCatalog: catalog, createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: root,
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false });
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });
const state = () => createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });

it('reads the selected runner, account home and session working folder', async () => {
  const read = vi.spyOn(catalog, 'get');
  const active = state();
  await owner.loadRunSkills(active, 'codex', profile);
  expect(read).toHaveBeenCalledWith({ runner: 'codex', accountHome: '/account', cwd: root });
  expect(active.skills.account).toBe('work');
  expect(owner.enabledSkills(active)).toEqual([entry]);
});

it('refuses catalog, row and query writes; a new process replaces its snapshot', async () => {
  const active = state();
  await owner.loadRunSkills(active, 'codex', profile);
  const snapshot = owner.enabledSkills(active);
  for (const value of [active.skills, snapshot, snapshot[0]!, active.skills.query!]) {
    expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.defineProperty(value, 'forged', { value: true })).toBe(false);
  }
  expect(() => Object.assign(active, { skills: state().skills })).toThrow(TypeError);
  expect(() => Object.assign(snapshot[0]!, { description: '/forged' })).toThrow(TypeError);
  expect(() => Array.prototype.push.call(snapshot, entry)).toThrow(TypeError);
  await owner.loadRunSkills(active, 'codex', profile);
  expect(owner.enabledSkills(active)).not.toBe(snapshot);
  expect(snapshot).toEqual([entry]);
  expect(state().skills.catalog).toEqual([]);
});

it('an unavailable list fails a selected skill with runner and account diagnostics', async () => {
  vi.spyOn(catalog, 'get').mockResolvedValue({ runner: 'codex', skills: [], problems: [], source: 'unavailable', reason: 'probe refused sentinel' });
  const active = state();
  await owner.loadRunSkills(active, 'codex', profile);
  expect(owner.selectedSkill(active, undefined, undefined, 'task')).toBeUndefined();
  expect(() => owner.selectedSkill(active, 'demo', undefined, 'task')).toThrow('codex account "work"');
  expect(() => owner.selectedSkill(active, 'demo', undefined, 'task')).toThrow('runner skill list is unavailable: probe refused sentinel');
});

it.each(['claude', 'codex'] as const)('opening an unknown command on %s reads only the opening snapshot', async runner => {
  const active = state();
  const read = vi.spyOn(catalog, 'get');
  await owner.loadRunSkills(active, runner, profile);
  const command = [{ type: 'text' as const, text: '/unknown arguments' }];
  expect(await owner.openingInput('opening', active, command)).toBe(command);
  expect(read).toHaveBeenCalledOnce();
});
