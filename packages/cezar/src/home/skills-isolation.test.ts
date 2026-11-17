import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { Home } from './home.ts';
import { useTestHome } from './test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fixture } from '../delegation/service.testkit.ts';
import { bareDirFor, reloadTeamSkills } from '../skills-remote.ts';
import { testHome } from './test-home.testkit.ts';

function isolatedHome(root: string): Home {
  const cache = join(root, 'cache');
  return { ...testHome({ CEZ_HOME: root }), cache, skillsCache: join(cache, 'skills'), skillFilesCache: join(cache, 'skill-files') };
}

function seedSkills(root: string, home: Home, name: string): void {
  const repo = join(root, name); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'commands'));
  writeFileSync(join(repo, 'commands', `${name}.md`), `---\nname: ${name}\n---\nUse the ${name} home.\n`);
  git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'skill');
  const bare = bareDirFor('team/skills', home); mkdirSync(dirname(bare), { recursive: true });
  git('clone', '--bare', repo, bare);
}

it('refuses team-only worker skills from both the selected and ambient home catalogs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-worker-skill-home-'));
  const selected = isolatedHome(join(root, 'selected'));
  const ambient = isolatedHome(join(root, 'ambient'));
  useTestHome(ambient);
  const f = fixture(undefined, selected);
  f.manager.setSkillCatalog(fixedSkillCatalog());
  try {
    seedSkills(root, selected, 'selected-skill'); seedSkills(root, ambient, 'ambient-skill');
    writeFileSync(join(f.root, '.ai/cezar/config.json'), JSON.stringify({ skillsRepos: [{ repo: 'team/skills' }] }));
    expect((await reloadTeamSkills(f.root, selected)).map(skill => skill.name)).toEqual(['selected-skill']);
    expect((await reloadTeamSkills(f.root, ambient)).map(skill => skill.name)).toEqual(['ambient-skill']);
    for (const skill of ['selected-skill', 'ambient-skill']) {
      await expect(f.service.spawn(f.caller, { task: 'Refuse team-only skill', baseline: 'HEAD', requestId: randomUUID(), skill }))
        .rejects.toThrow(`claude account "default" skill "${skill}" is missing from this worktree's list`);
    }
    expect(f.store.listWorkerIds()).toEqual([]);
  } finally { await f.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
