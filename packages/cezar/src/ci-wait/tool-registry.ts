import type { z } from 'zod';
import type { SquawkToolHandlers } from './controller.ts';
import { createKeyedRegistry } from '../core/registry.ts';

export type JsonObject = { type: 'object'; properties?: Record<string, unknown>; [key: string]: unknown };
export type AgentToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean | undefined; details: unknown };
/** One registration owns metadata, validation, transport policy and session dispatch. */
export interface AgentToolDefinition {
  name: string;
  description: string | (() => string);
  inputSchema: JsonObject | (() => JsonObject);
  trigger: string;
  label: string;
  enabled?(env: NodeJS.ProcessEnv): boolean;
  sessionHandlers?(runId: string, host: import('../workflows/run/squawk-tools.ts').ToolHost): Partial<SquawkToolHandlers>;
  sessionEnv?(env: NodeJS.ProcessEnv): Record<string, string>;
  envNames?(env: NodeJS.ProcessEnv): string[];
  maxBodyBytes?: number;
  timeoutMs?: number;
  schema: z.ZodType;
  runnerFields?: { ids: string[] };
  invalid(error: z.ZodError, input: unknown): unknown;
  oversized(): unknown;
  disabled?(): unknown;
  unavailable(error?: unknown, input?: unknown): unknown;
  /** Wait registration receipts survive session revocation after their commit. */
  committedReceipt?: boolean;
  handle(handlers: SquawkToolHandlers, input: unknown, signal: AbortSignal): Promise<unknown>;
  format?(answer: unknown): AgentToolResult;
  invoke(input: unknown): Promise<AgentToolResult>;
}
const registry = createKeyedRegistry<string, AgentToolDefinition>({
  name: 'Agent tool registry', reservedKeys: ['ci-wait'], bootHint: 'Call registerBuiltInTools(), then sealAgentTools() at boot.',
});
export const registerAgentTool = (tool: AgentToolDefinition): void => registry.register(tool.name, tool);
/** Throws what `registerAgentTool` would throw for this tool, without registering it. */
export const checkAgentToolRegistration = (tool: AgentToolDefinition): void => registry.check(tool.name, tool);
export const sealAgentTools = registry.seal;
export const agentToolsSealed = registry.isSealed;
export const registeredAgentTools = registry.values;
export const agentTool = registry.get;
export const agentToolNames = registry.keys;
export function enabledAgentTools(env: NodeJS.ProcessEnv = process.env): AgentToolDefinition[] {
  return registeredAgentTools().filter(tool => !tool.enabled || tool.enabled(env));
}
export function agentToolMetadata(tool: AgentToolDefinition) {
  return { name: tool.name, description: typeof tool.description === 'function' ? tool.description() : tool.description,
    inputSchema: typeof tool.inputSchema === 'function' ? tool.inputSchema() : tool.inputSchema,
    trigger: tool.trigger, label: tool.label };
}
export function agentToolInstructions(tools: Array<{ name: string; trigger: string }>): string {
  return ['The interface to Squawk, the orchestrator running this session. Load a tool below when its situation comes up.',
    ...tools.map(tool => `- ${tool.name}: ${tool.trigger}`)].join('\n');
}

/** Adapters receive transport policy with metadata so feature hints stay feature-owned. */
export function agentToolTransport(tool: AgentToolDefinition) {
  const answer = tool.unavailable();
  return { timeoutMs: tool.timeoutMs ?? 15_000,
    unavailable: formatAgentToolAnswer(tool, answer) };
}
export function formatAgentToolAnswer(tool: AgentToolDefinition, answer: unknown): AgentToolResult {
  return tool.format ? tool.format(answer) : { content: [{ type: 'text', text: JSON.stringify(answer) }], details: answer };
}
