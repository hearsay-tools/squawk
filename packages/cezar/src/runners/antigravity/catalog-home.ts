import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHomeDir } from '../../paths.ts';

/** Copy only native auth inputs. Discovery must never add conversations to a real account. */
export async function antigravityCatalogHome(env: NodeJS.ProcessEnv): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'squawk-antigravity-catalog-'));
  try {
    if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) {
      const target = join(home, 'antigravity-acp');
      await mkdir(target, { mode: 0o700 });
      for (const file of ['settings.json', 'acp_token.json']) {
        await writeFile(join(target, file), await readFile(join(agentHomeDir('antigravity', env), 'antigravity-acp', file)), { mode: 0o600 });
      }
    }
    return home;
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
}
