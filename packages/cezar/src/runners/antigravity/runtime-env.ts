import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentHomeDir } from '../../paths.ts';
import type { AgentRunSpec } from '../../core/agent-runner.ts';
import { buildChildEnv } from '../../core/agent-env.ts';
import { prepareAntigravityAccount } from './account-home.ts';

/** The account folder the CLI gets as --gemini-dir: the selected account, else the host's ~/.gemini. */
export function antigravityGeminiDir(env: NodeJS.ProcessEnv): string {
  return resolve(agentHomeDir('antigravity', env));
}

export function antigravityEnv(spec: Pick<AgentRunSpec, 'env'>): { env: NodeJS.ProcessEnv; temp: string; geminiDir: string } {
  const env = buildChildEnv({ backend: 'antigravity', extraEnv: spec.env });
  const geminiDir = antigravityGeminiDir(env);
  prepareAntigravityAccount(env.GEMINI_HOME);
  const temp = mkdtempSync(join(tmpdir(), 'squawk-antigravity-'));
  if (!env.GEMINI_API_KEY && env.GOOGLE_API_KEY) env.GEMINI_API_KEY = env.GOOGLE_API_KEY;
  // Keep the documented Gemini API endpoint override. Other GOOGLE_* flags select unrelated auth.
  for (const key of Object.keys(env)) if (key.startsWith('GOOGLE_') && key !== 'GOOGLE_GEMINI_BASE_URL') delete env[key];
  // The CLI ignores GEMINI_HOME (--gemini-dir carries the account) and keeps one OS keyring entry
  // for every account unless it believes it runs over SSH; then each account keeps its own file.
  delete env.GEMINI_HOME;
  env.SSH_CONNECTION ||= '127.0.0.1 0 127.0.0.1 0';
  env.AGY_CLI_DISABLE_AUTO_UPDATE = '1'; env.TMPDIR = temp;
  return { env, temp, geminiDir };
}
