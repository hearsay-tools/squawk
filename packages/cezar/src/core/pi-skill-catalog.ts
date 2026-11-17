import { z } from 'zod';
import { buildPiArgs } from './pi-args.ts';
import type { SkillCatalog } from './runner-skill-catalog.ts';
import { skillLines, skillProbe, type SkillDiscoveryOptions } from './skill-probe.ts';
import { skillPathScope } from './skill-path-scope.ts';
const commandsSchema = z.object({ commands: z.array(z.object({ name: z.string(), description: z.string().optional(),
  source: z.string(), sourceInfo: z.object({ path: z.string().optional(), source: z.string().optional(), scope: z.string().optional() }).optional(),
})) });
export function parsePiSkills(value: unknown, cwd: string, userHome = ''): SkillCatalog {
  return { skills: commandsSchema.parse(value).commands.filter(c => c.source === 'skill').map(c => {
    const origin = c.sourceInfo;
    const projectExtension = origin?.source === 'extension:pi-project-skills.mjs';
    const scope = projectExtension || origin?.scope === 'project' ? 'repo'
      : origin?.scope === 'user' ? 'user' : origin?.path ? skillPathScope(origin.path, cwd, userHome) : 'other';
    return { id: c.name.replace(/^skill:/, ''), name: c.name.replace(/^skill:/, ''), description: c.description,
      path: origin?.path, scope,
      ...(!projectExtension && origin?.source?.startsWith('extension:') ? { plugin: origin.source.slice('extension:'.length) } : {}),
    };
  }), problems: [] };
}
export function discoverPiSkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  const args = buildPiArgs({ cwd: options.cwd, userPrompt: '', toolGrant: { kind: 'unset' } });
  return skillProbe('pi', [...args, '--no-session'], options, async (child, _signal, env) => {
    child.stdin.write('{"id":"skills","type":"get_commands"}\n');
    for await (const line of skillLines(child)) {
      const message = JSON.parse(line);
      if (message.type !== 'response' || message.id !== 'skills' || message.command !== 'get_commands') continue;
      if (!message.success) throw new Error('pi skill list refused');
      return parsePiSkills(message.data, options.cwd, env.HOME ?? env.USERPROFILE ?? '');
    }
    throw new Error('pi skill list ended without an answer');
  });
}
