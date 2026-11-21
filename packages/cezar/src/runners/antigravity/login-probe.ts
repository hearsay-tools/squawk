import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { RunnerLoginStatus } from '../../core/runner-definition.ts';
import { agentHomeDir } from '../../paths.ts';
const settingsSchema = z.object({ auth: z.object({ type: z.string().min(1) }) });
async function storedOAuth(env: NodeJS.ProcessEnv): Promise<boolean> {
  const home = agentHomeDir('antigravity', env);
  const settings = settingsSchema.safeParse(JSON.parse(await readFile(join(home, 'antigravity-acp/settings.json'), 'utf8')));
  if (!settings.success || !['oauth-personal', 'oauth-business'].includes(settings.data.auth.type)) return false;
  const user = env.HOME || env.USERPROFILE || dirname(agentHomeDir('antigravity', {}));
  // Credential contents stay unread. File storage is enabled for every managed session.
  return (await stat(join(user, '.config/antigravity/plugin-secrets.json'))).isFile();
}
/** Presence is the same assurance as the other CLIs' stored-login status, not key validation. */
export const antigravityLogin: RunnerLoginStatus = {
  parse: result => result.exitCode === 0 && result.stdout.includes('antigravity_extensions/acp_server') ? 'disconnected' : null,
  async inspect(result, env) {
    if (result.exitCode !== 0 || !result.stdout.includes('antigravity_extensions/acp_server')) return null;
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'connected';
    return await storedOAuth(env).catch(() => false) ? 'connected' : 'disconnected';
  },
};
