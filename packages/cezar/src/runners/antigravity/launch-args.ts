import { productEnv } from '../../core/product-env.ts';

/** The ACP registry specifies --uid= only for Linux archives. */
export function antigravityLaunchArgs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...(platform === 'linux' ? ['--uid='] : []), ...(productEnv('ANTIGRAVITY_DEBUG', env) === '1' ? ['--debug'] : [])];
}
