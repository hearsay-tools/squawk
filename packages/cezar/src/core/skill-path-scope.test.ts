import { describe, it, expect } from 'vitest';
import { skillPathScope, skillPathPlugin } from './skill-path-scope.ts';

describe('native path metadata', () => {
  it('distinguishes project ancestors, the OS home, sibling paths and virtual built-ins', () => {
    const cwd = '/home/probe/projects/repo/sub';
    expect(skillPathScope('/home/probe/projects/repo/.agents/skills/a/SKILL.md', cwd, '/home/probe')).toBe('repo');
    expect(skillPathScope('/home/probe/.agents/skills/a/SKILL.md', cwd, '/home/probe')).toBe('user');
    expect(skillPathScope('/outside/skills/a/SKILL.md', cwd, '/home/probe')).toBe('other');
    expect(skillPathScope('/home/probe/projects/repo/submarine/a', cwd, '/home/probe')).toBe('user');
    expect(skillPathScope('<built-in>', cwd, '/home/probe')).toBe('system');
    expect(skillPathScope('skill://virtual', cwd, '/home/probe')).toBe('other');
  });
  it('uses the plugin path segment rather than a package URL', () => {
    expect(skillPathPlugin('/cache/packages/name@git+https:/github.com/owner/repo/plugins/plugin-name/skills/a/SKILL.md')).toBe('plugin-name');
    expect(skillPathPlugin('/home/probe/.codex/plugins/cache/market/plugin-name/v1/skills/a/SKILL.md')).toBe('plugin-name');
    expect(skillPathPlugin('/repo/.agents/skills/a/SKILL.md')).toBeUndefined();
  });
});
