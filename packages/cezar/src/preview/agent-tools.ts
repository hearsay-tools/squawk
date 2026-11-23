import { previewSessionHandlers } from './tool-session.ts';
import { productEnvEntries } from '../core/product-env.ts';
import { previewStopResult } from './registration.ts';
import { previewInvalidInput, previewOversized, previewRefusal } from './tool-errors.ts';
import { previewToolEnabled } from './tool-env.ts';
import { previewStopRequestSchema, previewStopResultSchema, previewServeRequestSchema, previewServeResultSchema } from '@open-mercato/cezar-contract/preview';
import type { AgentToolDefinition } from '../ci-wait/tool-registry.ts';
import { PREVIEW_TOOL, PREVIEW_STOP_TOOL, formatPreviewTool, formatPreviewStopTool } from './tools.ts';
import { bind, metadata } from '../ci-wait/tool-definition.ts';

export const previewAgentTools: AgentToolDefinition[] = [
  { ...metadata(PREVIEW_TOOL, previewServeResultSchema, formatPreviewTool), ...bind(previewServeRequestSchema, async (h, input, signal) => h.registerPreview ? previewServeResultSchema.parse(await h.registerPreview(input, signal)) : previewRefusal('headless')),
    sessionHandlers: (runId, host) => previewSessionHandlers(host, runId),
    sessionEnv: env => previewToolEnabled(env) ? productEnvEntries('PREVIEW', '1') : {},
    enabled: previewToolEnabled, envNames: env => previewToolEnabled(env) ? ['CEZ_PREVIEW'] : [], maxBodyBytes: 16_384,
    invalid: previewInvalidInput, oversized: previewOversized, disabled: () => previewRefusal('preview_disabled'), unavailable: () => previewRefusal('unavailable') },
  { ...metadata(PREVIEW_STOP_TOOL, previewStopResultSchema, formatPreviewStopTool), ...bind(previewStopRequestSchema, async (h, input, signal) => h.stopPreview ? previewStopResultSchema.parse(await h.stopPreview(input, signal)) : previewStopResult('headless')),
    enabled: previewToolEnabled, maxBodyBytes: 16_384, invalid: () => previewStopResult('invalid_input'), oversized: () => previewStopResult('invalid_input'), disabled: () => previewStopResult('preview_disabled'), unavailable: () => previewStopResult('unavailable') },
];
