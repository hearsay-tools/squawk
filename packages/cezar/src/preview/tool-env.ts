import { productEnv } from '../core/product-env.ts';
/** Live preview is enabled only by the exact value `1`. */
export function previewToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return productEnv('PREVIEW', env) === '1'; }
