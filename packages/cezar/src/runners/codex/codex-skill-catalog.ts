import { z } from 'zod';
import { CodexAppServerRpc } from './codex-app-server-transport.ts';
import { type SkillCatalog, skillLines, skillProbe, type SkillDiscoveryOptions } from '@hearsay-tools/squawk/plugin';
const listSchema = z.object({ data: z.array(z.object({ cwd: z.string(),
  skills: z.array(z.object({ name: z.string(), description: z.string().optional(), path: z.string(),
    scope: z.string(), pluginId: z.string().nullable().optional() })),
  errors: z.array(z.object({ message: z.string(), path: z.string().optional() })),
})) });
export function parseCodexSkills(value: unknown, cwd: string): SkillCatalog {
  const page = listSchema.parse(value).data.find(page => page.cwd === cwd);
  if (!page) throw new Error('Codex skill list omitted the requested folder');
  return { skills: page.skills.map(s => ({ id: s.name, name: s.name, description: s.description, path: s.path,
    scope: s.scope === 'repo' || s.scope === 'user' || s.scope === 'system' ? s.scope : 'other',
    ...(s.pluginId ? { plugin: s.pluginId } : {}),
  })), problems: page.errors };
}
export function discoverCodexSkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  return skillProbe('codex', ['app-server'], options, async child => {
    const rpc = new CodexAppServerRpc(child);
    const reader = (async () => {
      for await (const line of skillLines(child)) rpc.dispatchResponse(JSON.parse(line));
      throw new Error('Codex skill list ended without an answer');
    })().catch(() => rpc.close('Codex skill list transport closed'));
    try {
      await rpc.initialize();
      return parseCodexSkills(await rpc.request('skills/list', { cwds: [options.cwd] }), options.cwd);
    } finally { rpc.close(); void reader; }
  });
}
