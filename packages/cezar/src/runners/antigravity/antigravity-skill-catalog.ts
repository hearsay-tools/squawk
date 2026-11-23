import { existsSync, lstatSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { profileEnv } from '../../core/agent-profiles.ts';
import { productEnv } from '../../core/product-env.ts';
import type { SkillCatalog } from '../../core/runner-skill-catalog.ts';
import { skillPathScope } from '../../core/skill-path-scope.ts';
import { skillLines, skillProbe, type SkillDiscoveryOptions } from '../../core/skill-probe.ts';
import { agentHomeDir, agentUserHome } from '../../paths.ts';
import { ANTIGRAVITY_SHARED_SKILL_ENTRIES } from './account-home.ts';
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

export interface AntigravityProbePaths {
  home: string;
  geminiDir: string;
  sessionHome: string;
}

function rewriteRelativePath(path: string, fromDir: string, toDir: string): string | undefined {
  const suffix = relative(fromDir, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
    ? join(toDir, suffix) : undefined;
}

function rewriteProbePath(path: string | undefined, accountHome: string, probe?: AntigravityProbePaths): string | undefined {
  if (!path || !probe) return path;
  return rewriteRelativePath(path, probe.geminiDir, accountHome)
    ?? rewriteRelativePath(path, probe.home, probe.sessionHome)
    ?? path;
}

/** Antigravity ACP expands `/<skill>`, not `/<plugin>:<skill>`, even though `--print=/skills` namespaces some plugins. */
function triggerId(name: string, plugin?: string): string {
  const prefix = plugin ? `${plugin}:` : '';
  return prefix && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

export function parseAntigravitySkills(
  value: unknown,
  cwd: string,
  accountHome: string,
  probe?: AntigravityProbePaths,
): SkillCatalog {
  const { skills } = commandResultSchema.parse(value).command.data;
  return {
    skills: skills.map(skill => {
      const id = triggerId(skill.name, skill.plugin);
      const path = rewriteProbePath(skill.path, accountHome, probe);
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

/** Match prepareAntigravityAccount read-only: keep account-owned entries, inherit missing shared entries from defaultHome. */
function resolveSharedEntry(accountHome: string, defaultHome: string, rel: string): string | undefined {
  const own = join(accountHome, rel);
  try {
    lstatSync(own);
    return existsSync(own) ? own : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }
  if (accountHome === defaultHome) return undefined;
  const shared = join(defaultHome, rel);
  return existsSync(shared) ? shared : undefined;
}

/** Link non-.gemini/.config entries of sessionHome so `~/` paths in skills.json and plugins.json resolve natively. */
async function linkSessionHomeEntries(sessionHome: string, probeHome: string): Promise<void> {
  let entries;
  try { entries = await readdir(sessionHome, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === '.gemini' || entry.name === '.config') continue;
    const source = join(sessionHome, entry.name);
    let type: 'dir' | 'file' = entry.isDirectory() ? 'dir' : 'file';
    if (entry.isSymbolicLink()) {
      try { if ((await stat(source)).isDirectory()) type = 'dir'; } catch { /* broken link keeps file type */ }
    }
    try { await symlink(source, join(probeHome, entry.name), type); } catch { /* skip races or collisions */ }
  }
}

/** Stage a disposable HOME pointing at read-only customization entries of accountHome so `--print=/skills` never mutates it. */
async function stageProbeHome(
  accountHome: string,
  defaultHome: string,
  sessionHome: string,
): Promise<{ root: string; home: string; geminiDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'squawk-antigravity-skills-'));
  const home = join(root, 'home');
  const geminiDir = join(home, '.gemini');
  try {
    await mkdir(join(geminiDir, 'config'), { recursive: true });
    await mkdir(join(geminiDir, ANTIGRAVITY_APP_DATA_DIR), { recursive: true });
    await mkdir(join(home, '.config'), { recursive: true });
    await linkSessionHomeEntries(sessionHome, home);
    for (const rel of ANTIGRAVITY_SHARED_SKILL_ENTRIES) {
      const source = resolveSharedEntry(accountHome, defaultHome, rel);
      const type = rel.endsWith('skills') || rel.endsWith('plugins') ? 'dir' : 'file';
      if (source) await symlink(source, join(geminiDir, rel), type);
    }
    const config = join(accountHome, 'config', 'config.json');
    if (existsSync(config)) await copyFile(config, join(geminiDir, 'config', 'config.json'));
    return { root, home, geminiDir };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Query the Antigravity CLI's native `/skills` slash command offline with zero model turns (ADR 0066). */
export async function discoverAntigravitySkills(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
  options.signal?.throwIfAborted();
  const defaultHome = resolve(agentHomeDir('antigravity'));
  const accountHome = resolve(options.accountHome || defaultHome);
  const hostHome = agentUserHome();
  const sessionHome = options.accountHome && accountHome !== defaultHome
    ? resolve(profileEnv('antigravity', accountHome).HOME ?? hostHome)
    : resolve(hostHome);
  const { root, home, geminiDir } = await stageProbeHome(accountHome, defaultHome, sessionHome);
  let launch: AntigravityLaunch | undefined;
  try {
    const override = options.bin || productEnv('ANTIGRAVITY_BIN') || (productEnv('DRY_RUN') === '1'
      ? fileURLToPath(new URL('../../../scripts/mock-acp.mjs', import.meta.url)) : undefined);
    launch = launchAntigravity(override) ?? missingAntigravity(root);
    const args = ['--settings', '{"modelProvider":"gemini"}', '--output-format', 'stream-json',
      '--log-file', join(root, 'cli.log'), '--print=/skills'];
    const extraEnv = {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      GEMINI_API_KEY: 'squawk-skill-probe', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:1',
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    };
    const activeLaunch = launch;
    const probe: AntigravityProbePaths = { home, geminiDir, sessionHome };
    return await skillProbe('antigravity', args, options, async child => {
      child.stdin.end();
      for await (const line of skillLines(child)) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message?.event === 'command_result') return parseAntigravitySkills(message, options.cwd, accountHome, probe);
      }
      throw new Error('Antigravity skill list ended without an answer');
    }, { executable: activeLaunch.executable, extraEnv, onSpawn: pid => activeLaunch.bindProcess(pid) });
  } finally {
    try { launch?.release(); } catch { /* Pruning drops a lease whose owner process has exited. */ }
    await rm(root, { recursive: true, force: true });
  }
}
