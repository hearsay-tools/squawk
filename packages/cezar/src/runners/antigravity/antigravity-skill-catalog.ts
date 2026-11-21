import { prepareAntigravityAccount } from './account-home.ts';
import { readdir, readFile } from 'node:fs/promises';
import { agentHomeDir } from '../../paths.ts';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { SkillCatalog } from '../../core/runner-skill-catalog.ts';
import type { SkillDiscoveryOptions } from '../../core/skill-probe.ts';
const metadataSchema = z.object({ name: z.string().optional(), description: z.string().optional() });
/** Live-probed resolve_skills_paths order in antigravity-acp 1.5.0 (hearsay-tools/squawk#4000).
 * ACP exposes no skills/list; available_commands_update contains built-in commands only. */
export async function discoverAntigravitySkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  const home = options.accountHome || agentHomeDir('antigravity');
  prepareAntigravityAccount(options.accountHome);
  const roots = [
    { path: join(home, 'config', 'skills'), scope: 'user' as const },
    { path: join(options.cwd, '.gemini', 'skills'), scope: 'repo' as const },
    { path: join(home, 'antigravity-cli', 'skills'), scope: 'user' as const },
    { path: join(options.cwd, '.agents', 'skills'), scope: 'repo' as const },
  ];
  const skills: SkillCatalog['skills'] = [];
  const names = new Set<string>();
  for (const root of roots) {
    options.signal?.throwIfAborted();
    const entries = await readdir(root.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(root.path, entry.name, 'SKILL.md');
      const metadata = await skillMetadata(path);
      if (!metadata) continue;
      const id = metadata.name ?? entry.name;
      if (names.has(id)) continue;
      names.add(id);
      skills.push({ id, name: id, path, scope: root.scope, ...(metadata.description ? { description: metadata.description } : {}) });
    }
  }
  return { skills, problems: [] };
}
async function skillMetadata(path: string): Promise<z.infer<typeof metadataSchema> | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    return header === undefined ? {} : metadataSchema.parse(parse(header));
  } catch { return undefined; }
}
