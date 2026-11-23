import type { z } from 'zod';
import type { SquawkToolHandlers } from './controller.ts';
import type { SquawkTool } from './tools.ts';
/** The controller validates once with this schema before dispatching the typed callback. */
export function bind<S extends z.ZodType>(schema: S, handle: (handlers: SquawkToolHandlers, input: z.output<S>, signal: AbortSignal) => Promise<unknown>) {
  return { schema, handle: (handlers: SquawkToolHandlers, input: unknown, signal: AbortSignal) => handle(handlers, input as z.output<S>, signal) };
}
export function metadata<S extends z.ZodType>(tool: SquawkTool, schema: S, format: (answer: z.output<S>) => import('./tool-registry.ts').AgentToolResult) {
  return { name: tool.definition.name, description: () => tool.definition.description, inputSchema: () => tool.definition.inputSchema, trigger: tool.trigger, label: tool.label, invoke: tool.invoke,
    format: (answer: unknown) => format(schema.parse(answer)) };
}
