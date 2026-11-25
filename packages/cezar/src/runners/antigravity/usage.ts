import { z } from 'zod';
import type { TokenUsage } from '@hearsay-tools/squawk/plugin';
const usageSchema = z.object({ totalTokens: z.number(), inputTokens: z.number(), outputTokens: z.number(),
  thoughtTokens: z.number().optional(), cachedReadTokens: z.number().optional(), cachedWriteTokens: z.number().optional() });
export function antigravityUsage(value: unknown): TokenUsage | undefined {
  const usage = usageSchema.safeParse(value);
  if (!usage.success) return undefined;
  return { input: usage.data.inputTokens, output: usage.data.outputTokens, total: usage.data.totalTokens,
    ...(usage.data.thoughtTokens === undefined ? {} : { reasoning: usage.data.thoughtTokens }),
    ...(usage.data.cachedReadTokens === undefined ? {} : { cacheRead: usage.data.cachedReadTokens }),
    ...(usage.data.cachedWriteTokens === undefined ? {} : { cacheWrite: usage.data.cachedWriteTokens }),
  };
}
