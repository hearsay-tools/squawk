import { productEnv } from './product-env.ts';

/** A probe and a session must discover the same configured skill sources. */
export function claudeSettingSourceArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const sources = productEnv('CLAUDE_SETTING_SOURCES', env);
  return sources ? ['--setting-sources', sources] : [];
}
