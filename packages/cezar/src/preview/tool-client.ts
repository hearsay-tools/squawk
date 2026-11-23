import { callTool } from '../ci-wait/client.ts';
import { previewRefusal } from './tool-errors.ts';
import { previewStopResult } from './registration.ts';
import { previewServeResultSchema, previewStopResultSchema, type PreviewStopResult, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
/**
 * hearsay-tools/cezarion#781: posts the arguments unparsed, so the server names the failing field in its hint. Every
 * transport failure, refusal or unreadable answer becomes the typed `unavailable` result; this
 * never throws.
 */
export function callPreviewServe(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewServeResult> {
  return callTool(input, env, 'cezar_preview_serve', previewServeResultSchema, previewRefusal('unavailable'));
}

export function callPreviewStop(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewStopResult> {
  return callTool(input, env, 'cezar_preview_stop', previewStopResultSchema, previewStopResult('unavailable'));
}
