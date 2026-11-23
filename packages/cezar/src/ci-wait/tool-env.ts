import { productEnv } from '../core/product-env.ts';
import { automationsEnabled } from '../automations/enabled.ts';

/** Live preview is on under the exact value `1` only (spec 2026-10-02-live-preview-v1). */
export function previewToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return productEnv('PREVIEW', env) === '1';
}

/** Automations are on unless the value is exactly `0` (spec 2026-10-02-scheduled-automations). */
export function automationsToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return automationsEnabled(env);
}
