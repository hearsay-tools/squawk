import { writeMockSkills } from '../../packages/cezar/scripts/mock-skill-fixtures.mjs';
// The browser harness owns these catalogs; checkout catalogs never seed the server.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_CATALOGS = [
  '.ai/cezar/skills', '.ai/squawk/skills', '.ai/skills', '.agents/skills', '.claude/skills',
  '.codex/skills', '.cursor/skills', '.opencode/skills', '.ai/cezar/workflows', '.ai/squawk/workflows',
];
const fixtures = fileURLToPath(new URL('../../packages/web/e2e/fixtures/catalogs/', import.meta.url));

export function replaceProjectCatalogs(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  const tracked = git('ls-files', '-z', '--', ...PROJECT_CATALOGS);
  if (tracked.length) execFileSync('git', ['-C', root, 'update-index', '--skip-worktree', '-z', '--stdin'], { input: tracked });
  const ownerPath = join(root, '.git/cezar-e2e-lane.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  const exclude = join(root, '.git/info/exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, '', { flag: 'a' });
  const fixtureIgnore = '/.mock-runner-skills.json';
  if (!readFileSync(exclude, 'utf8').split(/\r?\n/).includes(fixtureIgnore)) {
    writeFileSync(exclude, `\n${fixtureIgnore}\n`, { flag: 'a' });
  }
  if (!owner.fixedCatalogs) {
    // These are fixture inputs, not project changes. Keep HEAD, log, index blobs and
    // non-catalog source edits intact so git UI specs see the original repository.
    writeFileSync(exclude, `\n${PROJECT_CATALOGS.map(path => `/${path}/`).join('\n')}\n`, { flag: 'a' });
    writeFileSync(ownerPath, JSON.stringify({ ...owner, fixedCatalogs: true }));
  }
  for (const relative of PROJECT_CATALOGS) rmSync(join(root, relative), { recursive: true, force: true });
  writeMockSkills(root, [
    { name: 'lint-fix', description: 'Fix lint findings in the changed files', scope: 'repo' },
    { name: 'spec-writer', description: 'Write a feature specification', scope: 'repo' },
  ]);
  for (const [source, relative] of [['workflows', '.ai/cezar/workflows']]) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(fixtures, source), target, { recursive: true });
  }
}
