import { productIdentity } from '../home/identity.ts';
import type { PreviewResultCode, PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import type { z } from 'zod';
const EXAMPLE_CALL = '{ "command": "npm run dev -- --port 5173 --strictPort", "port": 5173 }';

/** The refusals Squawk's tool server answers itself; registration codes come from its owner. */
export function previewRefusal(code: Extract<PreviewResultCode, 'preview_disabled' | 'headless' | 'unavailable'>): PreviewServeResult {
  switch (code) {
    case 'preview_disabled': return { ok: false, code, message: 'Live preview is not enabled in this cockpit.', hint: 'Do not retry. Tell the user the server command and port so they can open it themselves.' };
    case 'headless': return { ok: false, code, message: `No cockpit is attached to this run (\`${productIdentity().command} run\`).`, hint: 'Do not retry. Report the command and port in your final message.' };
    case 'unavailable': return { ok: false, code, message: `Squawk's tool server did not answer.`, hint: 'Retry once. If it fails again, continue without preview and report the command and port in your message.' };
  }
}

const FIELD_RULES: Record<string, string> = {
  command: 'must be a string of 1 to 1024 characters',
  port: 'must be an integer between 1 and 65535',
  cwd: 'must be a path relative to the worktree root',
  label: 'must be a string of 1 to 48 characters',
  path: 'must be a path starting with "/"',
};

export function previewOversized(): PreviewServeResult {
  return { ok: false, code: 'invalid_input', message: 'The arguments exceed 16 KiB.', hint: `Send only the documented fields, e.g. ${EXAMPLE_CALL}, and call again.` };
}

/** Names the first failing field and its rule, then a valid example call. */
export function previewInvalidInput(error: z.ZodError, input: unknown): PreviewServeResult {
  const field = error.issues.map(issue => issue.path[0]).find((key): key is string => typeof key === 'string' && key in FIELD_RULES);
  if (!field) {
    return { ok: false, code: 'invalid_input', message: 'The arguments must be a JSON object with `command` and `port`.', hint: `Call again with a JSON object, e.g. ${EXAMPLE_CALL}.` };
  }
  const value = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
  const got = value === undefined ? 'nothing' : JSON.stringify(value).slice(0, 64);
  return {
    ok: false,
    code: 'invalid_input',
    message: `\`${field}\` ${FIELD_RULES[field]} (got ${got}).`,
    hint: `"${field}" ${FIELD_RULES[field]}. A valid call: ${EXAMPLE_CALL}. Fix the field and call again.`,
  };
}
