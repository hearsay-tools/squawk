import { z } from 'zod';

export const agentToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })), isError: z.boolean().optional(), details: z.unknown(),
});

/** Metadata shared by the private IPC controller and external tool hosts. */
export const agentToolMetadataSchema = z.object({
  timeoutMs: z.number().positive(), unavailable: agentToolResultSchema,
  name: z.string(), description: z.string(), trigger: z.string(), label: z.string(),
  inputSchema: z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()).optional() }).catchall(z.unknown()),
});
export const agentToolCatalogSchema = z.object({ tools: z.array(agentToolMetadataSchema), instructions: z.string() });
