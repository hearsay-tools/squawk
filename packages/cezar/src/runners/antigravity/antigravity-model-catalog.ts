import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { effortLevelSchema } from '@open-mercato/cezar-contract/effort';
import type { ModelDiscoveryContext, ModelOption } from '../../core/runner-model-catalog.ts';
import { profileEnv } from '../../core/agent-profiles.ts';
import { agentHomeDir } from '../../paths.ts';
import { productEnv } from '../../core/product-env.ts';
import { AntigravityProbe } from './probe-process.ts';
import { antigravityPersonalSignIn } from './login-probe.ts';
import { antigravityExecutable, resolveAntigravityCommand } from './executable.ts';
import { ANTIGRAVITY_APP_DATA_DIR } from './launch-args.ts';

const optionSchema = z.object({ value: z.string(), name: z.string() });
const configsSchema = z.array(z.object({ id: z.string(), category: z.string().optional(), options: z.array(optionSchema).optional() }));

/** The executable's identity stands for its version: an update or a new override changes it. Hashes
 *  stay in memory; credential contents never enter the key. */
export async function antigravityModelCatalogKey(options: ModelDiscoveryContext): Promise<string> {
  const executable = antigravityExecutable();
  if (!executable) throw new Error('The Antigravity CLI is not installed');
  const file = await stat(resolveAntigravityCommand(executable), { bigint: true });
  const env = { ...process.env, ...profileEnv('antigravity', options.accountHome) };
  const home = agentHomeDir('antigravity', env);
  const hash = createHash('sha256').update(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '');
  // The CLI records the sign-in method here, with no secret (antigravity-wire.md, Folders).
  if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) hash.update(await readFile(join(home, ANTIGRAVITY_APP_DATA_DIR, 'cache', 'acp-auth-state.json')).catch(() => Buffer.from('absent')));
  return JSON.stringify([executable, String(file.ino), String(file.mtimeNs), String(file.size), home, hash.digest('hex')]);
}

/** Only a picker request opens this bounded session; boot/task start never calls it. An API key
 *  lists models from an empty folder, so discovery adds nothing to the account. */
export async function discoverAntigravityModels(options: { cwd: string } & ModelDiscoveryContext): Promise<ModelOption[]> {
  const accountEnv = profileEnv('antigravity', options.accountHome);
  const authEnv = { ...process.env, ...accountEnv };
  const keyed = !!(authEnv.GEMINI_API_KEY || authEnv.GOOGLE_API_KEY);
  if (!keyed && !await antigravityPersonalSignIn(authEnv).catch(() => false)) throw new Error('Sign in to Antigravity before discovering models');
  const scratch = keyed ? await mkdtemp(join(tmpdir(), 'squawk-antigravity-catalog-')) : undefined;
  let probe: AntigravityProbe | undefined;
  try {
    let configs: unknown;
    probe = new AntigravityProbe(productEnv('ANTIGRAVITY_BIN'), { ...(scratch ? profileEnv('antigravity', scratch) : accountEnv), BROWSER: '/bin/false' }, 20_000, {
      normalizeOptions: value => { configs = value; },
    });
    await probe.acp.initialize();
    // A stored Google sign-in is inferred by the CLI. Never start an interactive flow for discovery.
    if (probe.env.GEMINI_API_KEY) await probe.acp.authenticate('gemini-api-key');
    await probe.acp.open({ cwd: probe.cwd });
    const initial = configsSchema.parse(configs);
    const models = initial.find(option => option.id === 'model')?.options;
    if (!models?.length) throw new Error('Antigravity returned no models');
    const result: ModelOption[] = [];
    // Thinking choices depend on the model. No model turn is sent.
    for (const model of models) {
      const updated = configsSchema.parse(await probe.acp.setConfigOption('model', model.value));
      const thinking = updated.find(option => option.category === 'thought_level');
      const effortLevels = (thinking?.options ?? []).flatMap(option => {
        const parsed = effortLevelSchema.safeParse(option.value);
        return parsed.success ? [parsed.data] : [];
      });
      result.push({ id: model.value, label: model.name, description: 'From Antigravity', effortLevels });
    }
    return result;
  } catch (error) {
    await probe?.close(error);
    throw error;
  } finally {
    try { await probe?.close(); }
    finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
}
