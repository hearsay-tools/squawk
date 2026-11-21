import type { ModelOption } from '../../core/runner-model-catalog.ts';
// Live configOptions discovery ships in hearsay-tools/squawk#4003.
export async function discoverAntigravityModels(): Promise<ModelOption[]> {
  throw new Error('Antigravity model discovery is unavailable; use auto or enter a model id.');
}
