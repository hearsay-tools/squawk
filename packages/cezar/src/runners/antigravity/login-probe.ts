import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunnerLoginStatus } from '../../core/runner-definition.ts';
import { agentHomeDir } from '../../paths.ts';
const settingsSchema = z.object({ auth: z.object({ type: z.string().min(1) }) });
export async function storedPersonalOAuth(env: NodeJS.ProcessEnv): Promise<boolean> {
  const home = agentHomeDir('antigravity', env);
  const settings = settingsSchema.safeParse(JSON.parse(await readFile(join(home, 'antigravity-acp/settings.json'), 'utf8')));
  if (!settings.success || settings.data.auth.type !== 'oauth-personal') return false;
  // Credential contents stay unread. File storage is enabled for every managed session.
  return (await stat(join(home, 'antigravity-acp/acp_token.json'))).isFile();
}
/** Presence is the same assurance as the other CLIs' stored-login status, not key validation. */
export const antigravityLogin: RunnerLoginStatus = {
  requiresAccountHome: env => !(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
  parse: result => result.exitCode === 0 && result.stdout.includes('antigravity_extensions/acp_server') ? 'disconnected' : null,
  async inspect(result, env) {
    if (result.exitCode !== 0 || !result.stdout.includes('antigravity_extensions/acp_server')) return null;
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'connected';
    return await storedPersonalOAuth(env).catch(() => false) ? 'connected' : 'disconnected';
  },
  hint(env, status) {
    if (status === 'connected' && (env.GEMINI_API_KEY || env.GOOGLE_API_KEY)) {
      return `Uses ${env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GOOGLE_API_KEY'} from the Squawk host environment; no account folder is required.`;
    }
    return status === 'connected' ? 'Uses this account’s Antigravity personal sign-in.'
      : 'Connect with a personal Google account, or set GEMINI_API_KEY on the Squawk host. Business and agent-platform sign-in are not supported.';
  },
};
