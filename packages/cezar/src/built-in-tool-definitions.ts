import { askErrorMessage, askInvalidInput, ciErrorMessage, doneErrorMessage, doneInvalidInput, waitInvalidInput } from './ci-wait/errors.ts';

import { squawkAskAnswerSchema, squawkAskRequestSchema, squawkCancelWaitAnswerSchema, squawkCancelWaitRequestSchema, squawkDoneAnswerSchema, squawkDoneRequestSchema, squawkWaitAnswerSchema, squawkWaitRequestSchema } from '@open-mercato/cezar-contract/wait-tools';
import { ciWaitErrorCodeSchema } from '@open-mercato/cezar-contract/ci-wait';

import type { AgentToolDefinition } from './ci-wait/tool-registry.ts';
import { WAIT_TOOL, ASK_TOOL, CANCEL_WAIT_TOOL, DONE_TOOL, formatWaitTool, formatAskTool, formatCancelWaitTool, formatDoneTool } from './ci-wait/tools.ts';

import { bind, metadata } from './ci-wait/tool-definition.ts';
const invalid = (message: string) => ({ ok: false, code: 'invalid_request', message });
const unavailable = (message: string) => ({ ok: false, code: 'unavailable', message });
const ordinaryLimit = () => invalid('The arguments exceed 16 KiB.');
const thrownCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;

export const coreAgentTools: AgentToolDefinition[] = [
  { ...metadata(WAIT_TOOL, squawkWaitAnswerSchema, formatWaitTool), ...bind(squawkWaitRequestSchema, async (h, input, signal) => squawkWaitAnswerSchema.parse((await h.registerWait(input, 'cezar_wait', signal)).answer)),
    maxBodyBytes: 16_384, committedReceipt: true,
    invalid: error => ({ ...invalid(waitInvalidInput(error)), effect: 'refused' }),
    oversized: () => ({ ...invalid('The arguments exceed 16 KiB. Nothing was created.'), effect: 'refused' }),
    unavailable: (error, input) => {
      const code = ciWaitErrorCodeSchema.safeParse(thrownCode(error));
      const operation_id = input && typeof input === 'object' && 'operation_id' in input ? input.operation_id : undefined;
      return code.success ? { ok: false, effect: 'refused', code: code.data, message: ciErrorMessage(code.data), operation_id }
        : { ok: false, effect: 'unknown', code: 'outcome_unknown', message: 'Registration outcome is unknown. Retry the same operation_id and arguments; do not add a fallback wait.', operation_id };
    } },
  { ...metadata(ASK_TOOL, squawkAskAnswerSchema, formatAskTool), ...bind(squawkAskRequestSchema, async (h, input, signal) => squawkAskAnswerSchema.parse(await h.ask(input, signal))),
    maxBodyBytes: 262_144, invalid: error => invalid(askInvalidInput(error)), oversized: () => invalid('The arguments exceed 256 KiB.'), unavailable: () => unavailable(askErrorMessage('unavailable')) },
  { ...metadata(CANCEL_WAIT_TOOL, squawkCancelWaitAnswerSchema, formatCancelWaitTool), ...bind(squawkCancelWaitRequestSchema, async (h, input, signal) => squawkCancelWaitAnswerSchema.parse(await h.cancelWait(input, signal))),
    maxBodyBytes: 16_384, invalid: error => ({ cancelled: false, code: 'invalid_request', message: waitInvalidInput(error) }),
    oversized: () => ({ cancelled: false, code: 'invalid_request', message: 'The arguments exceed 16 KiB.' }), unavailable: () => ({ cancelled: false, code: 'unavailable', message: ciErrorMessage('unavailable') }) },
  { ...metadata(DONE_TOOL, squawkDoneAnswerSchema, formatDoneTool), ...bind(squawkDoneRequestSchema, async (h, input, signal) => squawkDoneAnswerSchema.parse(await h.finishTurn(input, signal))),
    maxBodyBytes: 16_384, invalid: error => invalid(doneInvalidInput(error)), oversized: ordinaryLimit, unavailable: () => unavailable(doneErrorMessage('unavailable')) },
];
