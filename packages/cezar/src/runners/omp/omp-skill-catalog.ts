import { z } from 'zod';
import type { SkillCatalog } from './runner-skill-catalog.ts';
import { skillOutput, skillProbe, type SkillDiscoveryOptions } from './skill-probe.ts';
const listSchema = z.object({ skills: z.array(z.object({ name: z.string(), description: z.string().optional(),
  filePath: z.string(), source: z.string() })),
  warnings: z.array(z.object({ message: z.string(), skillPath: z.string().optional() })),
});
export function parseOmpSkills(value: unknown): SkillCatalog {
  const result = listSchema.parse(value);
  return { skills: result.skills.map(s => {
    const [provider, level] = s.source.split(':');
    return { id: s.name, name: s.name, description: s.description, path: s.filePath,
      scope: level === 'project' ? 'repo' : level === 'user' ? 'user' : level === 'system' ? 'system' : 'other',
      ...(provider?.includes('plugins') ? { plugin: provider } : {}),
    };
  }), problems: result.warnings.map(w => ({ message: w.message, ...(w.skillPath ? { path: w.skillPath } : {}) })) };
}
export function discoverOmpSkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  return skillProbe('omp', ['skill', 'list', '--json'], options, async child => {
    child.stdin.end();
    return parseOmpSkills(JSON.parse(await skillOutput(child)));
  });
}
