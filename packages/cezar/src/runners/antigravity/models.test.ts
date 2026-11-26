import { describe, expect, it } from 'vitest';
import { antigravityQuotaPool } from './models.ts';

// hearsay-tools/squawk#4343: Antigravity bills Gemini and third-party models from separate quotas.
describe('antigravityQuotaPool', () => {
  it('names the Gemini pool for Gemini models', () => {
    expect(antigravityQuotaPool('gemini-4-neon')).toBe('gemini');
    expect(antigravityQuotaPool('gemini-3.1-pro-low')).toBe('gemini');
    expect(antigravityQuotaPool('antigravity/Gemini-4-Neon')).toBe('gemini');
  });

  it('names the third-party pool for every other named model', () => {
    expect(antigravityQuotaPool('claude-opus-5-5')).toBe('third-party');
    expect(antigravityQuotaPool('antigravity/gpt-oss-120b')).toBe('third-party');
  });

  it('names no pool for an empty id', () => {
    expect(antigravityQuotaPool('')).toBeUndefined();
    expect(antigravityQuotaPool('antigravity/')).toBeUndefined();
  });
});
