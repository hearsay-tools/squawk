import { type RunnerLoginStatus, productEnv } from '@hearsay-tools/squawk/plugin';
import { AcpRpcError } from '@hearsay-tools/squawk/plugin/acp';
import { AntigravityProbe } from './probe-process.ts';
import { antigravityInstalled, antigravityStatusFromPath } from './executable.ts';

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Whether the account holds a Google sign-in. Where the CLI stores it is not recorded, so the CLI
 * answers: with SSH_CONNECTION set it refuses `oauth-personal` at once when no sign-in is stored,
 * and opens no browser (antigravity-wire.md, CLI sign-in). Credential contents stay unread.
 */
export async function antigravityPersonalSignIn(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { GEMINI_HOME, HOME, USERPROFILE, XDG_CONFIG_HOME } = env;
  const account = Object.fromEntries(Object.entries({ GEMINI_HOME, HOME, USERPROFILE, XDG_CONFIG_HOME }).flatMap(([key, value]) => value ? [[key, value]] : []));
  const probe = new AntigravityProbe(productEnv('ANTIGRAVITY_BIN', env), { ...account, BROWSER: '/bin/false' }, 15_000);
  try {
    await probe.acp.initialize();
    await probe.acp.authenticate('oauth-personal');
    return true;
  } catch (error) {
    if (error instanceof AcpRpcError) return false;
    throw error;
  } finally { await probe.close(); }
}

const hasKey = (env: NodeJS.ProcessEnv) => !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);

/** Presence is the same assurance as the other CLIs' stored-login status, not key validation. */
export const antigravityLogin: RunnerLoginStatus = {
  requiresAccountHome: env => !hasKey(env),
  parse: result => result.exitCode === 0 && VERSION.test(result.stdout.trim()) ? 'disconnected' : null,
  async inspect(result, env) {
    // From PATH, the cached CLI check decides, whatever entry the status command ran: a cold read may
    // have run an IDE launcher that comes before the CLI. An override or managed release answers itself.
    if (antigravityStatusFromPath(env)) { if (!await antigravityInstalled(env)) return null; }
    else if (result.exitCode !== 0 || !VERSION.test(result.stdout.trim())) return null;
    if (hasKey(env)) return 'connected';
    return await antigravityPersonalSignIn(env).catch(() => false) ? 'connected' : 'disconnected';
  },
  hint(env, status) {
    if (status === 'connected' && hasKey(env)) {
      return `Uses ${env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GOOGLE_API_KEY'} from the Squawk host environment; no account folder is required.`;
    }
    return status === 'connected' ? 'Uses this account’s Google sign-in.'
      : 'Connect with a personal Google account, or set GEMINI_API_KEY on the Squawk host. Business and agent-platform sign-in are not supported.';
  },
};
