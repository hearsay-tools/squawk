import { skillOf, slashSkillPrompt } from '../../core/skill-trigger.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, ContentBlock } from '../../core/agent-runner.js';

/**
 * Wire helpers that the Pi-family RPC runners share: pi (`pi-runner.ts`) and its fork omp
 * (`omp-runner.ts`) speak the same prompt, message and tool-result shapes
 * (hearsay-tools/cezarion#2006).
 */

/** One RPC line as JSON, or undefined when it does not parse: JSON.parse never returns undefined. */
export function parseRpcLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A Squawk prompt as the RPC `prompt` command's message text and images. */
export function toPiPrompt(content: ContentBlock[]): {
  message: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
} {
  const text: string[] = [];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === 'text') text.push(block.text);
    else if (block.type === 'image') images.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
  }
  const skill = skillOf(content);
  const context = text.join('\n');
  return { message: skill ? slashSkillPrompt(skill, context) : context, images };
}

export function emitImages(value: unknown, onEvent?: (event: AgentEvent) => void): void {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (isRecord(part) && part.type === 'image') {
      const data = string(part.data);
      const mediaType = string(part.mimeType);
      if (data && mediaType) onEvent?.({ type: 'image', data, mediaType });
    }
  }
}

/** A message's text: a plain string, or its text parts joined like toPiPrompt. */
export function piMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content)
    ? message.content.flatMap(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
    : '';
}

export function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
  return text.length > 0 ? text.join('\n') : undefined;
}

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
}

export function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** pi's failure response: the error object's message, the response's message, or a generic line. */
export function piRpcError(value: Record<string, unknown>): string {
  return rpcErrorFor(value, 'pi');
}

/** OMP's failure response carries `error` as a string (rpc-mode.ts, v18.4.11), else as pi's. */
export function ompRpcError(value: Record<string, unknown>): string {
  if (typeof value.error === 'string') return value.error;
  return rpcErrorFor(value, 'omp');
}

function rpcErrorFor(value: Record<string, unknown>, cli: 'pi' | 'omp'): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `${cli} RPC command ${string(value.command) ?? 'unknown'} failed`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** OMP reports native expansion as a custom message rather than a user message. */
export function ompSkillPrompt(message: Record<string, unknown>): string | undefined {
  if (message.role !== 'custom' || message.customType !== 'skill-prompt' || !isRecord(message.details)) return undefined;
  return string(message.details.prompt);
}

/** Native expansions omit the request id. Bind once here, retaining the registered id.
 * Omp trims the prompt; pi trims arguments and wraps the skill body in XML. */
export function matchesSkillPrompt(message: Record<string, unknown>, prompt: string): boolean {
  const omp = ompSkillPrompt(message);
  if (omp !== undefined) return omp.trim() === prompt.trim();
  if (message.role !== 'user') return false;
  const text = piMessageText(message);
  const trigger = prompt.trim();
  const space = trigger.indexOf(' ');
  const name = trigger.slice('/skill:'.length, space < 0 ? undefined : space);
  const args = space < 0 ? '' : trigger.slice(space + 1).trim();
  return text.trim() === prompt.trim() ||
    text.startsWith(`<skill name="${name}" location="`) && text.endsWith(`</skill>\n\n${args}`);
}
