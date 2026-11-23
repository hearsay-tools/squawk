import { z } from 'zod';
import { previewStopRequestSchema, previewServeRequestSchema } from '@open-mercato/cezar-contract/preview';

export const previewToolDefinition = {
  name: 'cezar_preview_serve',
  description: `Register a web dev server of this task so the user can click through it in the cockpit's live preview. Always pin the port (\`vite --strictPort\`, \`next dev -p\`) so the server comes up on the port you register. Squawk starts the command itself when the user opens the preview; do not wait for the user. ` +
    'To drive the browser the user sees, connect to `$CEZ_PREVIEW_CDP_URL` when it is set, e.g. `agent-browser --cdp "$CEZ_PREVIEW_CDP_URL" --pin-tab open http://localhost:5173`; the user watches your page live. `agent-browser record` needs ffmpeg on PATH.',
  inputSchema: { ...z.toJSONSchema(previewServeRequestSchema, { io: 'input' }), type: 'object' as const },
};

export const previewStopToolDefinition = {
  name: 'cezar_preview_stop',
  description: `Stop a preview server Squawk started for your own task. Set restart to true to reuse the unchanged command the owner approved, including after a crash. Adopted servers cannot be stopped; changed registrations need the owner to press Run and open again.`,
  inputSchema: { ...z.toJSONSchema(previewStopRequestSchema, { io: 'input' }), type: 'object' as const },
};
