import { lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { agentHomeDir } from '@hearsay-tools/squawk/plugin';

export const ANTIGRAVITY_SHARED_SKILL_ENTRIES = [
  'config/skills',
  'config/skills.json',
  'config/plugins',
  'config/plugins.json',
  'antigravity-cli/skills',
  'skills',
] as const;

const SHARED_ENTRIES = [
  'AGENTS.md',
  'GEMINI.md',
  ...ANTIGRAVITY_SHARED_SKILL_ENTRIES,
] as const;

/** Native instructions, skills and plugins are shared; settings, conversations and OAuth secrets are not. */
export function prepareAntigravityAccount(accountHome: string | undefined, sourceHome = agentHomeDir('antigravity')): void {
  if (!accountHome || resolve(accountHome) === resolve(sourceHome)) return;
  const source = resolve(sourceHome);
  mkdirSync(accountHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(accountHome, '.squawk-home', '.config'), { recursive: true, mode: 0o700 });
  for (const relative of SHARED_ENTRIES) {
    const target = join(accountHome, relative);
    try { lstatSync(target); continue; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const kind = relative.endsWith('skills') || relative.endsWith('plugins') ? 'dir' : 'file';
    try { symlinkSync(join(source, relative), target, kind); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
