import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { identityOf, MANIFEST_FILE, type ManifestEntry } from './worktree-manifest.ts';
import { PROVISION_IGNORE_MARK } from './worktree-skill-cleanup.ts';

/** Saved files and manifest from the old installer, without retaining that installer. */
export async function seedOldSkills(worktree: string): Promise<{ paths: string[]; manifest: string }> {
  const paths = ['.agents/skills/old-copy', '.claude/skills/old-copy'];
  const entries: ManifestEntry[] = [];
  for (const path of paths) {
    mkdirSync(join(worktree, path), { recursive: true });
    writeFileSync(join(worktree, path, 'SKILL.md'), 'old installed copy\n');
    const ignore = `${dirname(path)}/.gitignore`;
    writeFileSync(join(worktree, ignore), `${PROVISION_IGNORE_MARK}\n/.gitignore\n/old-copy\n`);
    entries.push({ path, writer: 'skills', kind: 'generated', skill: 'old-copy', identity: (await identityOf(join(worktree, path)))! });
    entries.push({ path: ignore, writer: 'skills', kind: 'ignore-file', identity: (await identityOf(join(worktree, ignore)))! });
  }
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktree, encoding: 'utf8' }).trim();
  const manifest = join(gitDir, MANIFEST_FILE);
  writeFileSync(manifest, JSON.stringify({ version: 1, entries, skills: { roots: ['old-copy'] } }));
  return { paths, manifest };
}
