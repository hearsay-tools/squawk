/**
 * OpenCode's skill loader catches a skill it cannot load, publishes an
 * unscoped `UnknownError` session.error, then skips the skill and continues
 * (1.18.35 skill/index.ts:105-116):
 * https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/skill/index.ts#L105-L116
 * The message is `Failed to parse skill <path>` for an unreadable file
 * (hearsay-tools/cezarion#723, captured on 1.18.33), or the FrontmatterError
 * text from config/markdown.ts:20-34,
 * `<path>: Failed to parse YAML frontmatter: <parser detail>`:
 * https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/config/markdown.ts#L20-L34
 * A 2026-10-18 reproduction on OpenCode 1.18.35 (hearsay-tools/cezarion#1265)
 * showed the turn going on to answer after that frontmatter frame.
 *
 * Only those proven wire shapes are recoverable, and only for a `SKILL.md` path
 * at the start of the message. In particular an absent session ID alone says
 * nothing about severity, scoped errors remain failures even with the same text,
 * and every other unscoped error stays fatal.
 */
export function opencodeSkillWarning(props: Record<string, unknown>): string | undefined {
  if (props.sessionID !== undefined) return undefined;
  const error = record(props.error);
  if (error?.name !== 'UnknownError') return undefined;
  const message = record(error.data)?.message;
  if (typeof message !== 'string') return undefined;
  if (/^Failed to parse skill .+[\\/]SKILL\.md$/.test(message))
    return `opencode: optional skill skipped: ${message}. Check that the skill file and any symlink target are readable; repair or reinstall the skill.`;
  const frontmatter = /^(.+?[\\/]SKILL\.md): Failed to parse YAML frontmatter: ([\s\S]*)$/.exec(message);
  if (!frontmatter) return undefined;
  const [, path, rawDetail = ''] = frontmatter;
  // The parser detail ends in a multi-line caret excerpt; keep the note one line.
  const detail = rawDetail.replace(/\s+/g, ' ').trim();
  return `opencode: optional skill skipped: ${path} has invalid YAML frontmatter${detail ? ` (${detail})` : ''}. Fix the frontmatter between the --- lines, for example by quoting values that contain a colon or a quote, or remove the skill.`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Same reading of the wire error shape as the v2 mapper's `errorText`
 *  (`opencode-ui-mapper.ts`): a bare string, `{message}`, `{data:{message}}`
 *  (the real server's `ProviderAuthError` shape), or `{name}` as a last resort. */
export function sessionErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return 'session error';
  const rec = error as Record<string, unknown>;
  const data = typeof rec.data === 'object' && rec.data !== null ? (rec.data as Record<string, unknown>) : undefined;
  return (
    stringField(rec, 'message') ??
    (data && stringField(data, 'message')) ??
    stringField(rec, 'name') ??
    'session error'
  );
}

/** Structured upstream status or code, when the wire error carries one —
 *  the AI SDK's `AI_APICallError` exposes a numeric `statusCode`, and some
 *  providers nest a `code` inside `data`. Status wins over code; anything
 *  else adds nothing (#53). */
export function sessionErrorDetail(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const rec = error as Record<string, unknown>;
  const data = record(rec.data);
  const status =
    numField(rec, 'statusCode') ||
    numField(rec, 'status') ||
    (data ? numField(data, 'statusCode') : 0) ||
    (data ? numField(data, 'status') : 0);
  if (status > 0) return `HTTP ${status}`;
  const rawCode = rec.code ?? (data ? data.code : undefined);
  if (typeof rawCode === 'string' && rawCode.trim()) return `code ${rawCode.trim()}`;
  if (typeof rawCode === 'number') return `code ${rawCode}`;
  return undefined;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}
