import type { SquawkTool } from '../ci-wait/tools.ts';
import { previewToolDefinition, previewStopToolDefinition } from './tool-catalog.ts';
import { callPreviewServe, callPreviewStop } from './tool-client.ts';
/** JSON first, then the hint as a plain sentence: the shape every Squawk tool answers in. */
export async function invokePreviewTool(input: unknown) {
  return formatPreviewTool(await callPreviewServe(input));
}
export function formatPreviewTool(result: Awaited<ReturnType<typeof callPreviewServe>>) {
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${result.hint}` }], isError: !result.ok, details: result };
}
export async function invokePreviewStopTool(input: unknown) {
  return formatPreviewStopTool(await callPreviewStop(input));
}
export function formatPreviewStopTool(result: Awaited<ReturnType<typeof callPreviewStop>>) {
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${result.hint}` }], isError: !result.ok, details: result };
}
export const PREVIEW_STOP_TOOL: SquawkTool = { definition: previewStopToolDefinition, trigger: `load when your Squawk-started preview server needs stopping or restarting.`, label: 'Stop live preview', invoke: invokePreviewStopTool };

export const PREVIEW_TOOL: SquawkTool = { definition: previewToolDefinition, trigger: 'load when you have started, or are about to start, a web server the user should click through.', label: 'Live preview', invoke: invokePreviewTool };
