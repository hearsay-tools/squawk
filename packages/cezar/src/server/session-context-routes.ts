import { Hono } from 'hono';
import { sessionContextPreviewRequestSchema, setSessionContextSchema } from '@open-mercato/cezar-contract/session-context';
import { previewSessionContext } from '../session-context.ts';
import { readSessionContextState, writeSessionContextFile } from '../session-context-file.ts';
import type { ProjectApiEnv } from './server-types.ts';
import { jsonZodValidator } from './validators.ts';

/**
 * Settings → Session context (hearsay-tools/squawk#4308, hearsay-tools/squawk#4341). Writing `context.local.yaml`
 * needs no `settingsAdmin`: the file runs no host command, is gitignored, and its file includes
 * stay inside the worktree (ADR 0055 gates only settings that persist host commands).
 */
export function createSessionContextRoutes() {
  return new Hono<ProjectApiEnv>()
    .get('/session-context', async (c) => c.json(await readSessionContextState(c.get('project').root)))

    .post('/session-context/preview', jsonZodValidator(sessionContextPreviewRequestSchema), (c) => {
      const body = c.req.valid('json');
      return c.json(previewSessionContext({ projectRoot: c.get('project').root, content: body.content, role: body.role }));
    })

    .put('/session-context', jsonZodValidator(setSessionContextSchema), async (c) => {
      const body = c.req.valid('json');
      const out = await writeSessionContextFile(c.get('project').root, body.content, body.version);
      if (!out.ok) return c.json({ error: out.error }, out.status);
      return c.json(out.state);
    });
}
