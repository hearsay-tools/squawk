import { z } from 'zod';
import { skillLines, skillPathPlugin, skillPathScope, skillProbe } from '@hearsay-tools/squawk/plugin/runtime';
import type { SkillCatalog, SkillDiscoveryOptions } from '@hearsay-tools/squawk/plugin';
const listSchema = z.array(z.object({ name: z.string(), description: z.string().nullable().optional(), location: z.string() }));
export function parseOpencodeSkills(value: unknown, cwd: string, userHome = ''): SkillCatalog {
  return { skills: listSchema.parse(value).filter(s => !s.location.split(/[\\/]/).includes('.trash')).map(s => ({
    id: s.name, name: s.name, ...(s.description != null ? { description: s.description } : {}), path: s.location,
    scope: skillPathScope(s.location, cwd, userHome), ...(skillPathPlugin(s.location) ? { plugin: skillPathPlugin(s.location) } : {}),
  })), problems: [] };
}
export function discoverOpencodeSkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  return skillProbe('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], options, async (child, signal, env) => {
    for await (const line of skillLines(child)) {
      // Read only the loopback endpoint the owned server prints, never an arbitrary URL.
      const endpoint = line.match(/\bhttp:\/\/127\.0\.0\.1:(\d+)\b/);
      if (!endpoint) continue;
      const response = await fetch(`${endpoint[0]}/skill?directory=${encodeURIComponent(options.cwd)}`, { signal });
      if (!response.ok) throw new Error('OpenCode skill list refused');
      // OpenCode sends skill bodies too. Bound the response, then strip them at the boundary.
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw new Error('OpenCode skill list has no body');
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new Error('OpenCode skill list exceeded the output limit');
        chunks.push(chunk);
      }
      return parseOpencodeSkills(JSON.parse(Buffer.concat(chunks).toString()), options.cwd, env.HOME ?? env.USERPROFILE ?? '');
    }
    throw new Error('OpenCode skill server ended without an endpoint');
  });
}
