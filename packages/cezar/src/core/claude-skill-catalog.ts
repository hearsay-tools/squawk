import { z } from 'zod';
import { claudeSettingSourceArgs } from './claude-setting-sources.ts';
import type { SkillCatalog } from './runner-skill-catalog.ts';
import { skillLines, skillProbe, type SkillDiscoveryOptions } from './skill-probe.ts';

const responseSchema = z.object({ skills: z.array(z.object({
  name: z.string(), display_name: z.string().optional(), description: z.string().optional(), source: z.string(),
})) });
export function parseClaudeSkills(value: unknown): SkillCatalog {
  const { skills } = responseSchema.parse(value);
  return { skills: skills.map(s => ({ id: s.name, name: s.display_name ?? s.name, description: s.description,
    scope: s.source === 'project' ? 'repo' : s.source === 'user' ? 'user' : 'other',
    ...(s.source === 'plugin' ? { plugin: s.name.split(':')[0] } : {}),
  })), problems: [] };
}
export function discoverClaudeSkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  return skillProbe('claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--settings', '{"disableAllHooks":true}', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...claudeSettingSourceArgs()], options, async child => {
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'skills', request: { subtype: 'get_skills_dialog' } }) + '\n');
    for await (const line of skillLines(child)) {
      const message = JSON.parse(line);
      if (message.type !== 'control_response' || message.response?.request_id !== 'skills') continue;
      if (message.response.subtype !== 'success') throw new Error('Claude skill list refused');
      return parseClaudeSkills(message.response.response);
    }
    throw new Error('Claude skill list ended without an answer');
  });
}
