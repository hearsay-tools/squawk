import type { RunnerModelData } from '@hearsay-tools/squawk/plugin';

/** Antigravity bills Gemini models and third-party models (Claude and others) from separate quotas:
 *  "Third-party quota reached. Please switch to Gemini models" (hearsay-tools/squawk#4343). */
export function antigravityQuotaPool(model: string): string | undefined {
  const id = model.slice(model.lastIndexOf('/') + 1).trim().toLowerCase();
  if (!id) return undefined;
  return id.startsWith('gemini-') ? 'gemini' : 'third-party';
}

export const ANTIGRAVITY_MODELS: RunnerModelData = {
  catalogAtAdmission: false,
  suggested: [{ id: '', label: 'auto', desc: 'Use your Antigravity default model' }],
  known: [], retired: [], idMap: { nativeIdNamespace: 'antigravity' },
  quotaPool: antigravityQuotaPool,
};
