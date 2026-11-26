import { SESSION_CONTEXT_FILE_MAX_BYTES } from '@open-mercato/cezar-contract/session-context';
import { readProjectPath } from './project-paths.ts';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml';
import { z } from 'zod';

/**
 * Session-start context injection (hearsay-tools/cezarion#1584, docs/context-injection.md).
 *
 * Every cezar-managed launch — a fresh step, a check retry, Continue, recovery, an owned
 * worker — opens with a prefix of labeled blocks before the task: the run's whole handoff
 * first, then the project's optional `.ai/cezar/context.yaml` rules in file order. Inputs are
 * read again for each launch; the rendered prefix is fixed for that launch. Nothing here
 * throws: every failure skips the block it affects and says why in the reports.
 */

/** The complete injection prefix — labels and separators included — counted in UTF-8 bytes. */
export const SESSION_CONTEXT_LIMIT_BYTES = 65_536;
/** Project rules, relative to the project root. Optional: absent means no custom rules. */
export const SESSION_CONTEXT_FILE = '.ai/cezar/context.yaml';
/** The built-in handoff block's id; a custom rule cannot take it. */
export const HANDOFF_CONTEXT_ID = 'handoff';
/** Divides the prefix from the opening message. */
export const SESSION_CONTEXT_SEPARATOR = '\n\n---\n\n';

/** Variables a template may name; `{{file:<path>}}` is the one other token form. */
export const SESSION_CONTEXT_VARIABLES = [
  'task', 'run.id', 'role', 'workflow.name', 'step.id', 'project.root', 'worktree.root', 'handoff.path',
] as const;
export type SessionContextVariable = typeof SESSION_CONTEXT_VARIABLES[number];

export type SessionContextRole = 'parent' | 'worker';

export interface SessionContextRule {
  id: string;
  target: 'parent' | 'worker' | 'both';
  template: string;
}

export const SESSION_CONTEXT_REPORT_STATUSES = ['applied', 'skipped'] as const;
export type SessionContextReportStatus = (typeof SESSION_CONTEXT_REPORT_STATUSES)[number];

/** One rule's outcome for one launch. `applied` means "in the launch prompt", not "delivered". */
export interface SessionContextReport {
  id: string;
  status: SessionContextReportStatus;
  /** Files the block read: the handoff's absolute path, or a rule's paths as written. */
  sources: string[];
  /** UTF-8 bytes of the block as rendered, when it was rendered. */
  bytes?: number;
  reason?: string;
}

export interface SessionContext {
  /** The prefix to put in front of the opening message, separator included; `''` for none. */
  prefix: string;
  /** Whether the handoff block made it in — when not, the agent keeps the read instruction. */
  handoffInjected: boolean;
  reports: SessionContextReport[];
}

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
/** A larger config file is refused unread. */
const CONFIG_LIMIT_BYTES = SESSION_CONTEXT_FILE_MAX_BYTES;
const CONFIG_REPORT_ID = 'context.yaml';

const ruleSchema = z.object({
  id: z.string().regex(RULE_ID, 'id must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit'),
  on: z.literal('session_start', { error: 'on must be session_start' }),
  target: z.enum(['parent', 'worker', 'both'], { error: 'target must be parent, worker or both' }).default('both'),
  template: z.string().min(1, 'template must not be empty'),
}).strict();

type ReadResult = { ok: true; text: string } | { ok: false; reason: string; missing?: boolean };

/**
 * Read at most `limit` bytes of strict UTF-8; a larger file is refused, never truncated. Only a
 * regular file is read. The open never blocks: a FIFO would otherwise wait for a writer and stall
 * the launch path, which runs synchronously on the event loop.
 */
function readBoundedUtf8(path: string, limit: number): ReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (stat.isDirectory()) return { ok: false, reason: 'is a directory' };
    if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
    const size = stat.size;
    if (size > limit) return { ok: false, reason: `larger than ${limit} bytes` };
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read)) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'not found', missing: true };
    if (error instanceof TypeError) return { ok: false, reason: 'not valid UTF-8' };
    return { ok: false, reason: code === 'EISDIR' ? 'is a directory' : `unreadable (${code ?? 'error'})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read and validate the project's rules. A missing file is no rules and no warning; a file that
 * cannot be read or parsed, or has another version, skips every custom rule with one report;
 * a bad, duplicate or reserved rule skips that rule alone.
 */
export function loadSessionContextRules(projectRoot: string): { rules: SessionContextRule[]; reports: SessionContextReport[] } {
  const file = readBoundedUtf8(readProjectPath(projectRoot, 'context.yaml'), CONFIG_LIMIT_BYTES);
  if (!file.ok) {
    return file.missing ? { rules: [], reports: [] } : { rules: [], reports: [configSkip(file.reason)] };
  }
  const { rules, reports } = parseSessionContextText(file.text);
  return { rules, reports };
}

/** One thing the cockpit editor must fix before it saves; `line` is 1-based, `rule` the 1-based rule. */
export interface SessionContextProblem {
  line: number | null;
  rule: number | null;
  message: string;
}

export interface ParsedSessionContext {
  /** The rules a launch renders, as `loadSessionContextRules` returns them. */
  rules: SessionContextRule[];
  /** What a launch reports for the file and its skipped rules. */
  reports: SessionContextReport[];
  /** Every problem in the text, sorted by line. Empty means the file is safe to save. */
  problems: SessionContextProblem[];
}

/**
 * Parse `context.yaml` text once for both readers: a launch takes `rules` and `reports`, the
 * cockpit editor takes `problems`, each with the line it starts on.
 */
export function parseSessionContextText(text: string): ParsedSessionContext {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const lineAt = (offset: number | undefined) => (offset === undefined ? null : lineCounter.linePos(offset).line);
  const fatal = (reason: string, message: string, line: number | null): ParsedSessionContext => ({
    rules: [], reports: [configSkip(reason)], problems: [{ line, rule: null, message }],
  });
  const firstError = doc.errors[0];
  if (firstError) {
    const detail = oneLine(firstError.message);
    return fatal(`invalid YAML: ${detail}`, `Invalid YAML: ${detail}`, lineAt(firstError.pos[0]) ?? 1);
  }
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (error) {
    // An alias with no anchor parses cleanly and fails only here.
    const detail = oneLine(error instanceof Error ? error.message : String(error));
    return fatal(`invalid YAML: ${detail}`, `Invalid YAML: ${detail}`, 1);
  }
  if (value === null || value === undefined) return { rules: [], reports: [], problems: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return fatal('expected a mapping with version and rules', 'The file must be a mapping with version and rules', 1);
  }
  const root = isMap(doc.contents) ? doc.contents : undefined;
  const { version, rules } = value as { version?: unknown; rules?: unknown };
  if (version !== 1) {
    const found = describeValue(version);
    const message = version === undefined ? 'version: 1 is required' : `version must be 1, not ${found}`;
    return fatal(`unsupported version ${found}; expected 1`, message, keyLine(root, 'version', lineAt) ?? 1);
  }
  if (rules === undefined || rules === null) return { rules: [], reports: [], problems: [] };
  if (!Array.isArray(rules)) return fatal('rules must be a list', 'rules must be a list', keyLine(root, 'rules', lineAt) ?? 1);

  const seq = root?.get('rules', true);
  const nodes = isSeq(seq) ? seq.items : [];
  return { ...validateRules(rules), problems: ruleProblems(rules, nodes as Array<YamlNode | undefined>, lineAt) };
}

type LineAt = (offset: number | undefined) => number | null;

/** The line a mapping's `key` starts on, or undefined when the key is absent. */
function keyLine(map: unknown, key: string, lineAt: LineAt): number | undefined {
  if (!isMap(map)) return undefined;
  const pair = map.items.find((item) => isScalar(item.key) && item.key.value === key);
  const keyNode = pair?.key as YamlNode | undefined;
  return lineAt(keyNode?.range?.[0]) ?? undefined;
}

/** The editor's view of each rule: every schema issue, the reserved id and each duplicate id. */
function ruleProblems(rules: unknown[], nodes: Array<YamlNode | undefined>, lineAt: LineAt): SessionContextProblem[] {
  const ids = rules.map((raw) => (isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined));
  const counts = new Map<string, number>();
  for (const id of ids) if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  const problems: SessionContextProblem[] = [];
  rules.forEach((raw, index) => {
    const node = nodes[index];
    const ruleLine = lineAt(node?.range?.[0]);
    const lineOf = (key: string) => keyLine(node, key, lineAt) ?? ruleLine;
    const add = (line: number | null, message: string) => problems.push({ line, rule: index + 1, message });
    const id = ids[index];
    if (id === HANDOFF_CONTEXT_ID) add(lineOf('id'), `id "${HANDOFF_CONTEXT_ID}" is reserved for the built-in handoff block`);
    if (id !== undefined && (counts.get(id) ?? 0) > 1) add(lineOf('id'), `duplicate id "${id}"`);
    const result = ruleSchema.safeParse(raw);
    if (result.success) return;
    for (const issue of result.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) add(lineOf(key), `unknown key "${key}"`);
        continue;
      }
      const key = issue.path[0];
      if (typeof key !== 'string') add(ruleLine, 'A rule must be a mapping with id, on and template');
      else if (isRecord(raw) && !(key in raw)) add(ruleLine, `${key} is required`);
      else add(lineOf(key), issue.message.startsWith(key) ? issue.message : `${key}: ${issue.message}`);
    }
  });
  return problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** A rejected value for a message: scalars as JSON, collections by kind (they can be circular). */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object' && value !== null) return 'a mapping';
  return JSON.stringify(value ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Each rule on its own: one bad, duplicate or reserved rule never takes the others down. */
function validateRules(rules: unknown[]): { rules: SessionContextRule[]; reports: SessionContextReport[] } {
  const reports: SessionContextReport[] = [];
  const parsed: Array<SessionContextRule | undefined> = rules.map((raw, index) => {
    const rawId = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : undefined;
    const label = rawId && RULE_ID.test(rawId) ? rawId : `rules[${index}]`;
    const result = ruleSchema.safeParse(raw);
    if (!result.success) {
      reports.push(skip(label, `invalid rule: ${oneLine(result.error.issues.map((issue) => `${issue.path.join('.') || 'rule'}: ${issue.message}`).join('; '))}`));
      return undefined;
    }
    if (result.data.id === HANDOFF_CONTEXT_ID) {
      reports.push(skip(label, `id "${HANDOFF_CONTEXT_ID}" is reserved for the built-in handoff`));
      return undefined;
    }
    return { id: result.data.id, target: result.data.target, template: result.data.template };
  });
  // A duplicated id is ambiguous: skip every rule that carries it, not just the later ones.
  const counts = new Map<string, number>();
  for (const rule of parsed) if (rule) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
  const valid: SessionContextRule[] = [];
  for (const rule of parsed) {
    if (!rule) continue;
    if ((counts.get(rule.id) ?? 0) > 1) reports.push(skip(rule.id, 'duplicate id'));
    else valid.push(rule);
  }
  return { rules: valid, reports };
}

export interface SessionContextInput {
  projectRoot: string;
  /** The receiving session's working directory: where `{{file:…}}` paths resolve. */
  cwd: string;
  role: SessionContextRole;
  handoffPath: string;
  variables: Partial<Record<SessionContextVariable, string>>;
}

/** Build one launch's prefix: read the handoff and the rules now, render for this recipient. */
export function buildSessionContext(input: SessionContextInput): SessionContext {
  return assemble(input, readBoundedUtf8(input.handoffPath, SESSION_CONTEXT_LIMIT_BYTES), loadSessionContextRules(input.projectRoot));
}

type RenderedBlock = (id: string, body: string) => void;

function assemble(
  input: SessionContextInput,
  handoff: ReadResult,
  loaded: { rules: SessionContextRule[]; reports: SessionContextReport[] },
  onApplied?: RenderedBlock,
): SessionContext {
  const reports: SessionContextReport[] = [];
  const blocks: string[] = [];
  let handoffInjected = false;
  const fits = (block: string) =>
    Buffer.byteLength([...blocks, block].join('\n\n') + SESSION_CONTEXT_SEPARATOR, 'utf8') <= SESSION_CONTEXT_LIMIT_BYTES;

  if (!handoff.ok) {
    reports.push({ ...skip(HANDOFF_CONTEXT_ID, handoff.reason), sources: [input.handoffPath] });
  } else {
    const block = renderBlock(HANDOFF_CONTEXT_ID, handoff.text, input.handoffPath);
    const bytes = Buffer.byteLength(block, 'utf8');
    if (fits(block)) {
      blocks.push(block);
      handoffInjected = true;
      reports.push({ id: HANDOFF_CONTEXT_ID, status: 'applied', sources: [input.handoffPath], bytes });
      onApplied?.(HANDOFF_CONTEXT_ID, handoff.text);
    } else {
      reports.push({ ...skip(HANDOFF_CONTEXT_ID, `does not fit the ${SESSION_CONTEXT_LIMIT_BYTES}-byte limit`), sources: [input.handoffPath], bytes });
    }
  }

  reports.push(...loaded.reports);
  for (const rule of loaded.rules) {
    if (rule.target !== 'both' && rule.target !== input.role) continue;
    const rendered = renderTemplate(rule.template, input);
    if (!rendered.ok) {
      reports.push({ ...skip(rule.id, rendered.reason), sources: rendered.sources });
      continue;
    }
    const block = renderBlock(rule.id, rendered.text);
    const bytes = Buffer.byteLength(block, 'utf8');
    if (!fits(block)) {
      reports.push({ ...skip(rule.id, `does not fit the ${SESSION_CONTEXT_LIMIT_BYTES}-byte limit`), sources: rendered.sources, bytes });
      continue;
    }
    blocks.push(block);
    reports.push({ id: rule.id, status: 'applied', sources: rendered.sources, bytes });
    onApplied?.(rule.id, rendered.text);
  }
  return { prefix: blocks.length ? blocks.join('\n\n') + SESSION_CONTEXT_SEPARATOR : '', handoffInjected, reports };
}

/** The preview keeps this many characters of each block's text; its byte count stays whole. */
export const SESSION_CONTEXT_PREVIEW_TEXT_CHARS = 2_000;
const SAMPLE_HANDOFF_PATH = '<handoff.path>';
const SAMPLE_HANDOFF = '# Handoff — <task>\n\n## Goal\n\n<task>\n\n## Progress log\n\n## Resume notes\n';

export interface SessionContextPreviewBlock {
  id: string;
  /** `built-in` for the handoff; null for an entry the file could not name a target for. */
  target: SessionContextRule['target'] | 'built-in' | null;
  status: SessionContextReportStatus | 'not-for-role';
  bytes: number | null;
  reason: string | null;
  sources: string[];
  /** The rendered text, cut to `SESSION_CONTEXT_PREVIEW_TEXT_CHARS`; null when nothing rendered. */
  text: string | null;
  truncated: boolean;
}

export interface SessionContextPreview {
  problems: SessionContextProblem[];
  blocks: SessionContextPreviewBlock[];
  usedBytes: number;
  limitBytes: number;
}

/**
 * Render a draft `context.yaml` the way a launch would: against the project checkout, for one
 * role, with labelled sample values (`<run.id>`) for every task variable and a sample handoff.
 */
export function previewSessionContext(options: { projectRoot: string; content: string; role: SessionContextRole }): SessionContextPreview {
  const parsed = parseSessionContextText(options.content);
  const variables = Object.fromEntries(SESSION_CONTEXT_VARIABLES.map((name) => [name, `<${name}>`])) as Record<SessionContextVariable, string>;
  variables.role = options.role;
  const input: SessionContextInput = {
    projectRoot: options.projectRoot, cwd: options.projectRoot, role: options.role, handoffPath: SAMPLE_HANDOFF_PATH, variables,
  };
  const texts = new Map<string, string>();
  const context = assemble(input, { ok: true, text: SAMPLE_HANDOFF }, parsed, (id, body) => texts.set(id, body.replace(/\n+$/, '')));
  // `assemble` reports the handoff first, then the file's own skips, then each rendered rule.
  // Valid rule ids are unique and never `handoff`; a skipped entry can share any id.
  const [handoffReport, ...rest] = context.reports;
  const reportFor = new Map(rest.slice(parsed.reports.length).map((report) => [report.id, report]));
  const block = (report: SessionContextReport, target: SessionContextPreviewBlock['target']): SessionContextPreviewBlock => {
    const text = texts.get(report.id) ?? null;
    return {
      id: report.id, target, status: report.status, bytes: report.bytes ?? null, reason: report.reason ?? null, sources: report.sources,
      text: text === null ? null : text.slice(0, SESSION_CONTEXT_PREVIEW_TEXT_CHARS),
      truncated: text !== null && text.length > SESSION_CONTEXT_PREVIEW_TEXT_CHARS,
    };
  };
  const blocks: SessionContextPreviewBlock[] = [block(handoffReport!, 'built-in')];
  for (const rule of parsed.rules) {
    const report = reportFor.get(rule.id);
    blocks.push(report
      ? block(report, rule.target)
      : { id: rule.id, target: rule.target, status: 'not-for-role', bytes: null, reason: null, sources: [], text: null, truncated: false });
  }
  for (const report of parsed.reports) blocks.push({ ...block(report, null), text: null, truncated: false });
  return { problems: parsed.problems, blocks, usedBytes: Buffer.byteLength(context.prefix, 'utf8'), limitBytes: SESSION_CONTEXT_LIMIT_BYTES };
}

/** The one lifecycle line a launch reports: each block's outcome, never its contents. */
export function formatSessionContextReport(reports: readonly SessionContextReport[]): string {
  const parts = reports.map((report) => {
    const detail = [report.bytes !== undefined ? `${report.bytes} B` : undefined, ...report.sources].filter(Boolean).join(', ');
    return `${report.id} ${report.status}${detail ? ` (${detail})` : ''}${report.reason ? ` — ${report.reason}` : ''}`;
  });
  return `session context: ${parts.length ? parts.join('; ') : 'nothing to inject'}`;
}

function renderBlock(id: string, body: string, source?: string): string {
  const attrs = source ? ` id="${id}" source="${escapeAttribute(source)}"` : ` id="${id}"`;
  return `<cezar-context${attrs}>\n${body.replace(/\n+$/, '')}\n</cezar-context>`;
}

type Rendered = { ok: true; text: string; sources: string[] } | { ok: false; reason: string; sources: string[] };

/**
 * The bytes a block body will have, counted as its pieces arrive. A run of LF at the end is held
 * apart: `renderBlock` drops it, so it counts only once later text follows it.
 */
class RenderedSize {
  private committed = 0;
  private lfRun = 0;

  add(text: string): void {
    const body = text.replace(/\n+$/, '');
    const run = text.length - body.length;
    if (body === '') {
      this.lfRun += run;
      return;
    }
    this.committed += this.lfRun + Buffer.byteLength(body, 'utf8');
    this.lfRun = run;
  }

  get over(): boolean {
    return this.committed > SESSION_CONTEXT_LIMIT_BYTES;
  }
}

/**
 * Expand a template in one pass over the template text only: a value or file content that
 * holds `{{…}}` stays literal. Every token is resolved before anything is emitted, so one bad
 * token skips the whole rule instead of shipping a half-rendered block. Once the body alone is
 * over the limit the block cannot fit, so rendering stops: repeated includes must not grow a
 * small template into an unbounded string.
 */
function renderTemplate(template: string, input: SessionContextInput): Rendered {
  const sources: string[] = [];
  const values: string[] = [];
  const size = new RenderedSize();
  const tooLarge = (): Rendered => ({ ok: false, reason: `does not fit the ${SESSION_CONTEXT_LIMIT_BYTES}-byte limit`, sources });
  let literalStart = 0;
  for (const match of template.matchAll(TOKEN)) {
    size.add(template.slice(literalStart, match.index));
    literalStart = match.index + match[0].length;
    const token = match[1]!;
    if (token.startsWith('file:')) {
      const path = token.slice('file:'.length).trim();
      sources.push(path);
      const file = readIncludedFile(input.cwd, path);
      if (!file.ok) return { ok: false, reason: `file ${path}: ${file.reason}`, sources };
      size.add(file.text);
      if (size.over) return tooLarge();
      values.push(file.text);
      continue;
    }
    if (!(SESSION_CONTEXT_VARIABLES as readonly string[]).includes(token)) {
      return { ok: false, reason: `unknown variable {{${token}}}`, sources };
    }
    const value = input.variables[token as SessionContextVariable];
    if (value === undefined) return { ok: false, reason: `variable {{${token}}} is not available for this launch`, sources };
    size.add(value);
    values.push(value);
  }
  let index = 0;
  return { ok: true, text: template.replace(TOKEN, () => values[index++]!), sources };
}

/** A relative path inside the receiving worktree, symlinks resolved; anything else is refused. */
function readIncludedFile(cwd: string, path: string): ReadResult {
  if (!path) return { ok: false, reason: 'empty path' };
  if (isAbsolute(path)) return { ok: false, reason: 'absolute paths are not allowed' };
  let root: string;
  let target: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return { ok: false, reason: 'the worktree is not readable' };
  }
  try {
    target = realpathSync(resolve(root, path));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, reason: 'not found', missing: true }
      : { ok: false, reason: `unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const inside = relative(root, target);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { ok: false, reason: 'outside the worktree' };
  return readBoundedUtf8(target, SESSION_CONTEXT_LIMIT_BYTES);
}

function configSkip(reason: string): SessionContextReport {
  return { id: CONFIG_REPORT_ID, status: 'skipped', sources: [SESSION_CONTEXT_FILE], reason: `${reason}; custom rules skipped` };
}

function skip(id: string, reason: string): SessionContextReport {
  return { id, status: 'skipped', sources: [], reason };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
