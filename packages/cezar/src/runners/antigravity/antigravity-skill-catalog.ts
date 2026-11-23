import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { productEnv } from '../../core/product-env.ts';
import type { SkillCatalog } from '../../core/runner-skill-catalog.ts';
import { skillPathScope } from '../../core/skill-path-scope.ts';
import { skillLines, skillProbe, type SkillDiscoveryOptions } from '../../core/skill-probe.ts';
import { agentHomeDir } from '../../paths.ts';
import { prepareAntigravityAccount } from './account-home.ts';
import { launchAntigravity, missingAntigravity, type AntigravityLaunch } from './executable.ts';
import { ANTIGRAVITY_APP_DATA_DIR } from './launch-args.ts';

const skillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  path: z.string().optional(),
  plugin: z.string().optional(),
  builtin: z.boolean().optional(),
});
const commandResultSchema = z.object({
  event: z.literal('command_result'),
  command: z.object({
    name: z.literal('skills'),
    data: z.object({ skills: z.array(skillSchema) }),
  }),
});

const LINKED_ENTRIES = [
  { rel: 'config/skills', type: 'dir' },
  { rel: 'config/skills.json', type: 'file' },
  { rel: 'config/plugins', type: 'dir' },
  { rel: 'config/plugins.json', type: 'file' },
  { rel: 'skills', type: 'dir' },
  { rel: `${ANTIGRAVITY_APP_DATA_DIR}/skills`, type: 'dir' },
] as const;

function rewriteProbePath(path: string | undefined, accountHome: string, probeGeminiDir?: string): string | undefined {
  if (!path || !probeGeminiDir) return path;
  const suffix = relative(probeGeminiDir, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
    ? join(accountHome, suffix) : path;
}

/** Antigravity ACP expands `/<skill>`, not `/<plugin>:<skill>`, even though `--print=/skills` namespaces some plugins. */
function triggerId(name: string, plugin?: string): string {
  const prefix = plugin ? `${plugin}:` : '';
  return prefix && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

export function parseAntigravitySkills(value: unknown, cwd: string, accountHome: string, probeGeminiDir?: string): SkillCatalog {
  const { skills } = commandResultSchema.parse(value).command.data;
  return {
    skills: skills.map(skill => {
      const id = triggerId(skill.name, skill.plugin);
      const path = rewriteProbePath(skill.path, accountHome, probeGeminiDir);
      const scope = skill.builtin ? 'system' : path ? skillPathScope(path, cwd, accountHome) : 'other';
      return {
        id, name: id,
        ...(skill.description ? { description: skill.description } : {}),
        ...(path ? { path } : {}),
        scope,
        ...(skill.plugin ? { plugin: skill.plugin } : {}),
      };
    }),
    problems: [],
  };
}

/** Stage a disposable HOME pointing at read-only customization entries of accountHome so `--print=/skills` never mutates it. */
async function stageProbeHome(accountHome: string): Promise<{ home: string; geminiDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'squawk-antigravity-skills-'));
  const geminiDir = join(home, '.gemini');
  try {
    await mkdir(join(geminiDir, 'config'), { recursive: true });
    await mkdir(join(geminiDir, ANTIGRAVITY_APP_DATA_DIR), { recursive: true });
    await mkdir(join(home, '.config'), { recursive: true });
    for (const entry of LINKED_ENTRIES) {
      const source = join(accountHome, entry.rel);
      if (existsSync(source)) await symlink(source, join(geminiDir, entry.rel), entry.type);
    }
    const config = join(accountHome, 'config', 'config.json');
    if (existsSync(config)) await copyFile(config, join(geminiDir, 'config', 'config.json'));
    return { home, geminiDir };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

/** Query the Antigravity CLI's native `/skills` slash command offline with zero model turns (ADR 0066). */
export async function discoverAntigravitySkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  options.signal?.throwIfAborted();
  const accountHome = resolve(options.accountHome || agentHomeDir('antigravity'));
  if (options.accountHome && existsSync(options.accountHome)) prepareAntigravityAccount(options.accountHome);
  const { home, geminiDir } = await stageProbeHome(accountHome);
  let launch: AntigravityLaunch | undefined;
  try {
    const override = options.bin || productEnv('ANTIGRAVITY_BIN') || (productEnv('DRY_RUN') === '1'
      ? fileURLToPath(new URL('../../../scripts/mock-acp.mjs', import.meta.url)) : undefined);
    launch = launchAntigravity(override) ?? missingAntigravity(home);
    const args = ['--settings', '{"modelProvider":"gemini"}', '--output-format', 'stream-json',
      '--log-file', join(home, 'cli.log'), '--print=/skills'];
    const extraEnv = {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      GEMINI_API_KEY: 'squawk-skill-probe', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:1',
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    };
    const activeLaunch = launch;
    return await skillProbe('antigravity', args, options, async child => {
      child.stdin.end();
      for await (const line of skillLines(child)) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message?.event === 'command_result') return parseAntigravitySkills(message, options.cwd, accountHome, geminiDir);
      }
      throw new Error('Antigravity skill list ended without an answer');
    }, { executable: activeLaunch.executable, extraEnv, onSpawn: pid => activeLaunch.bindProcess(pid) });
  } finally {
    try { launch?.release(); } catch { /* Pruning drops a lease whose owner process has exited. */ }
    await rm(home, { recursive: true, force: true });
  }
}
