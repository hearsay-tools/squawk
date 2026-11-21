import { z } from 'zod';
export function filterAntigravityUpdate(update: Record<string, unknown>): boolean {
  const content = z.object({ text: z.string() }).safeParse(update.content);
  return !(update.sessionUpdate === 'agent_message_chunk' && content.success && content.data.text.includes('Concurrent receive_steps() calls are not supported'));
}

export function antigravityUpdateError(update: Record<string, unknown>): string | undefined {
  const content = z.object({ text: z.string() }).safeParse(update.content);
  return update.sessionUpdate === 'agent_message_chunk' && content.success && content.data.text.startsWith('Agent execution error:') ? content.data.text : undefined;
}
