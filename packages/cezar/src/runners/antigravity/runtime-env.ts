import { prepareAntigravityAccount } from './account-home.ts';
import { accessSync, constants, existsSync, realpathSync, mkdtempSync } from 'node:fs';
import { delimiter, dirname, join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRunSpec } from '../../core/agent-runner.ts';
import { buildChildEnv } from '../../core/agent-env.ts';

export function antigravityHarness(bin: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const candidates = isAbsolute(bin) || bin.includes('/') ? [resolve(cwd, bin)] : (env.PATH ?? '').split(delimiter).map(dir => join(dir, bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const harness = join(dirname(realpathSync(candidate)), 'localharness_external');
      return existsSync(harness) ? harness : undefined;
    } catch { /* An absent agy is handled by spawn, never at boot. */ }
  }
  return undefined;
}
export function antigravityEnv(bin: string, spec: AgentRunSpec): { env: NodeJS.ProcessEnv; temp: string } {
  const env = buildChildEnv({ backend: 'antigravity', extraEnv: spec.env });
  prepareAntigravityAccount(env.GEMINI_HOME);
  const temp = mkdtempSync(join(tmpdir(), 'squawk-antigravity-'));
  const harness = antigravityHarness(bin, env, spec.cwd);
  if (!env.GEMINI_API_KEY && env.GOOGLE_API_KEY) env.GEMINI_API_KEY = env.GOOGLE_API_KEY;
  // Keep the documented Gemini API endpoint override. Other GOOGLE_* flags select unrelated auth.
  for (const key of Object.keys(env)) if (key.startsWith('GOOGLE_') && key !== 'GOOGLE_GEMINI_BASE_URL') delete env[key];
  env.AGY_ACP_FORCE_FILE_STORAGE = '1'; env.AGY_CLI_DISABLE_AUTO_UPDATE = '1'; env.TMPDIR = temp;
  if (harness && !env.ANTIGRAVITY_HARNESS_PATH) env.ANTIGRAVITY_HARNESS_PATH = harness;
  return { env, temp };
}
