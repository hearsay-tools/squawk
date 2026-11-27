import type { TokenUsage } from '../ui-events.ts';

/** The usage of every prompt one logical turn carried. */
export function addUsage(total: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  if (!total) return usage;
  const result: TokenUsage = { input: total.input + usage.input, output: total.output + usage.output, total: total.total + usage.total };
  for (const key of ['reasoning', 'cacheRead', 'cacheWrite'] as const) {
    if (total[key] !== undefined || usage[key] !== undefined) result[key] = (total[key] ?? 0) + (usage[key] ?? 0);
  }
  return result;
}
