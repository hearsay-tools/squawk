import { lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { agentHomeDir } from '../../paths.ts';

/** Native instructions and skills are shared; settings, conversations and OAuth secrets are not. */
export function prepareAntigravityAccount(accountHome: string | undefined, sourceHome = agentHomeDir('antigravity')): void {
  if (!accountHome || resolve(accountHome) === resolve(sourceHome)) return;
  mkdirSync(accountHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(accountHome, '.squawk-home', '.config'), { recursive: true, mode: 0o700 });
  for (const relative of ['AGENTS.md', 'GEMINI.md', 'config/skills', 'antigravity-cli/skills']) {
    const target = join(accountHome, relative);
    try { lstatSync(target); continue; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    try { symlinkSync(join(sourceHome, relative), target, relative.endsWith('skills') ? 'dir' : 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
