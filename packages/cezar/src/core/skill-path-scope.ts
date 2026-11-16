import { isAbsolute, relative, sep } from 'node:path';
import type { RunnerSkillScope } from '@open-mercato/cezar-contract/runner-skills';

function within(folder: string, path: string): boolean {
  const suffix = relative(folder, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}
/** Location metadata only: never read a skill file or scan a skill folder. */
export function skillPathScope(path: string, cwd: string, userHome: string): RunnerSkillScope {
  if (!isAbsolute(path)) return path === '<built-in>' ? 'system' : 'other';
  if (within(cwd, path)) return 'repo';
  const normalized = path.split(sep).join('/');
  const marker = normalized.search(/\/(?:\.agents|\.claude|\.opencode|\.pi)\/skills?\//);
  if (marker !== -1) {
    const root = normalized.slice(0, marker);
    if (root !== userHome && within(root, cwd)) return 'repo';
  }
  if (userHome && within(userHome, path)) return 'user';
  // OpenCode's built-in skills may have a virtual location rather than a file path.
  return 'other';
}
export function skillPathPlugin(path: string): string | undefined {
  const marker = path.match(/\/(?:plugins\/cache\/[^/]+\/([^/]+)|plugins\/([^/]+)\/skills\/)/);
  return marker?.[1] ?? marker?.[2];
}
