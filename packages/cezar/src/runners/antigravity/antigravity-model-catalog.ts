import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { effortLevelSchema } from '@open-mercato/cezar-contract/effort';
import type { ModelDiscoveryContext, ModelOption } from '../../core/runner-model-catalog.ts';
import { profileEnv } from '../../core/agent-profiles.ts';
import { agentHomeDir } from '../../paths.ts';
import { productEnv } from '../../core/product-env.ts';
import { AntigravityProbe } from './probe-process.ts';
import { storedPersonalOAuth } from './login-probe.ts';
import { antigravityBuildLabel } from './build-label.ts';

const optionSchema = z.object({ value: z.string(), name: z.string() });
const configsSchema = z.array(z.object({ id: z.string(), category: z.string().optional(), options: z.array(optionSchema).optional() }));
const executable = () => productEnv('ANTIGRAVITY_BIN') ?? 'agy';

/** Hashes stay in memory. Never retain credential contents or put them in cache diagnostics. */
export async function antigravityModelCatalogKey(options: ModelDiscoveryContext): Promise<string> {
  const bin = executable();
  const version = await antigravityBuildLabel(bin);
  const env = { ...process.env, ...profileEnv('antigravity', options.accountHome) };
  const home = agentHomeDir('antigravity', env);
  const hash = createHash('sha256').update(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '');
  for (const path of env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? [] : [join(home, 'antigravity-acp/settings.json'), join(home, 'antigravity-acp/acp_token.json')]) {
    hash.update(await readFile(path).catch(() => Buffer.from('absent')));
  }
  return JSON.stringify([bin, version, home, hash.digest('hex')]);
}

/** Only a picker request opens this bounded session; boot/task start never calls it. */
export async function discoverAntigravityModels(options: { cwd: string } & ModelDiscoveryContext): Promise<ModelOption[]> {
  const accountEnv = profileEnv('antigravity', options.accountHome);
  const authEnv = { ...process.env, ...accountEnv };
  if (!authEnv.GEMINI_API_KEY && !authEnv.GOOGLE_API_KEY && !await storedPersonalOAuth(authEnv).catch(() => false)) {
    throw new Error('Sign in to Antigravity before discovering models');
  }
  let configs: unknown;
  const probe = new AntigravityProbe(executable(), { ...accountEnv, BROWSER: '/bin/false', SSH_CONNECTION: 'squawk-model-discovery' }, 20_000, {
    normalizeOptions: value => { configs = value; },
  });
  try {
    await probe.acp.initialize();
    // Stored personal OAuth is inferred by agy. Never start an interactive flow for discovery.
    if (probe.env.GEMINI_API_KEY) await probe.acp.authenticate('gemini-api-key');
    await probe.acp.open({ cwd: probe.cwd });
    const initial = configsSchema.parse(configs);
    const models = initial.find(option => option.id === 'model')?.options;
    if (!models?.length) throw new Error('Antigravity returned no models');
    const result: ModelOption[] = [];
    // Thinking choices depend on the model (e.g. Pro has no medium). No model turn is sent.
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
  } finally { await probe.close(); }
}
