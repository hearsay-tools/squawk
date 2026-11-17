import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { child, children, type AstRule, type EsNode } from './ast-rule.ts';
import { literal, nodeLine, offset, propertyName, unwrap } from './ast-syntax.ts';
import { scanned } from './contract-root-import.ts';
import { blankOnce, repoRoot } from './source-rule.ts';

/**
 * Run facts have one home in `packages/contract` (hearsay-tools/cezarion#1496): a reader decides
 * on the attention rung id, never on the label copy, and calls `isUsageLimitHold` rather than
 * spelling the hold out. Types catch a new rung id; this scan catches the two things types cannot,
 * a label comparison (in any file) and a restated hold (in a source file), plus an `autoResumeAt`
 * read in a source file the reader list does not name.
 * Oxlint supplies the source tree; the visitors inspect the named syntax.
 */
/** The facts' home: it defines the rungs and the hold, and its tests keep the deleted copies as oracles. */
const HOME = 'packages/contract/src/';
export const readersPath = join(repoRoot, 'packages/cezar/src/lint/resume-time-readers.json');

/** Source files that read or write `autoResumeAt`, each with its reason. */
export function readReaders(path = readersPath): Record<string, string> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, string> }).files;
}

type Rule = 'label-comparison' | 'restated-hold' | 'resume-time-read';
export interface Site { file: string; line: number; rule: Rule; text: string }

const isTest = (file: string) => /\.(?:test|e2e)\.tsx?$|\.testkit\.tsx?$|\/test\//.test(file);

/** Where the receiver of the `.label` at `dot` starts, when it is an attention: a name ending in
 *  `attention` or `Attention` (a property path included), or a `deriveAttention(…)` call. -1 otherwise. */
function attentionReceiver(code: string, dot: number): number {
  const name = /[\w$.?]*[aA]ttention$/.exec(code.slice(Math.max(0, dot - 80), dot));
  if (name) return dot - name[0].length;
  if (code.charAt(dot - 1) !== ')') return -1;
  let depth = 0;
  for (let i = dot - 1; i >= 0; i--) {
    const ch = code.charAt(i);
    if (ch === ')') depth++;
    else if (ch === '(' && --depth === 0) {
      const callee = /\bderiveAttention\s*$/.exec(code.slice(Math.max(0, i - 40), i));
      return callee ? i - callee[0].length : -1;
    }
  }
  return -1;
}

/** A comparison or a text test made on the label: `===`, `!==`, a string method, or a `switch`.
 *  `start` is where the receiver starts and `end` where `.label` ends. */
function comparesLabel(code: string, start: number, end: number): boolean {
  if (/^\s*(?:===|!==|==|!=)|^\.(?:startsWith|endsWith|includes|toLowerCase|toUpperCase|match|localeCompare)\b/.test(code.slice(end, end + 24))) return true;
  return /(?:===|!==|==|!=)\s*$|\bswitch\s*\(\s*$/.test(code.slice(Math.max(0, start - 24), start));
}

/** Every `status` compared with `'waiting'`, as offsets in `code`. */
function waitingComparisons(source: string, code: string): Array<{ start: number; end: number }> {
  const sites: Array<{ start: number; end: number }> = [];
  const quoted = (at: number, length: number) => /^(['"])waiting\1$/.test(source.slice(at, at + length));
  for (const match of code.matchAll(/\.status\s*(?:===|!==)\s*(['"]) *\1/g)) {
    const literal = match[0].length - match[0].search(/['"]/);
    if (quoted(match.index + match[0].length - literal, literal)) sites.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of code.matchAll(/(['"]) *\1\s*(?:===|!==)\s*[\w$.?]*\.status\b/g)) {
    const literal = match[0].search(/\s*(?:===|!==)/);
    if (quoted(match.index, literal)) sites.push({ start: match.index, end: match.index + match[0].length });
  }
  return sites;
}

/** Whether a `.autoResumeAt` sits in the same condition as the comparison: joined by `&&` or `||`,
 *  with no statement or block boundary between. */
function joinedWithResumeTime(code: string, at: { start: number; end: number }): boolean {
  const joined = (between: string) => /&&|\|\|/.test(between) && !/[;{}]/.test(between);
  const after = code.slice(at.end, at.end + 160);
  const forward = after.search(/\??\.autoResumeAt\b/);
  if (forward >= 0 && joined(after.slice(0, forward))) return true;
  const before = code.slice(Math.max(0, at.start - 160), at.start);
  const back = [...before.matchAll(/\??\.autoResumeAt\b/g)].at(-1);
  return back !== undefined && joined(before.slice(back.index + back[0].length));
}

let listed: Record<string, string> | undefined;

export function scanRunFacts(file: string, source: string, readers: Record<string, string> = (listed ??= readReaders())): Site[] {
  const code = blankOnce(source);
  const lines = source.split('\n');
  const lineAt = (offset: number) => code.slice(0, offset).split('\n').length;
  const site = (rule: Rule, offset: number): Site => ({ file, line: lineAt(offset), rule, text: lines[lineAt(offset) - 1]!.trim() });
  const sites: Site[] = [];
  if (!file.startsWith(HOME)) {
    for (const match of code.matchAll(/\??\.label\b/g)) {
      const start = attentionReceiver(code, match.index);
      if (start >= 0 && comparesLabel(code, start, match.index + match[0].length)) sites.push(site('label-comparison', match.index));
    }
    // A test may spell the hold out: there it is an oracle for the record the engine wrote.
    for (const at of isTest(file) ? [] : waitingComparisons(source, code)) {
      if (joinedWithResumeTime(code, at)) sites.push(site('restated-hold', at.start));
    }
  }
  if (!isTest(file) && !(file in readers)) {
    const first = code.search(/\??\.autoResumeAt\b/);
    if (first >= 0) sites.push(site('resume-time-read', first));
  }
  return sites;
}

/** Whether `source` still reads the resume time: a listed file that does not is a stale entry. */
export const readsResumeTime = (source: string): boolean => /\??\.autoResumeAt\b/.test(blankOnce(source));

const HOW: Record<Rule, string> = {
  'label-comparison': 'decide on `attention.rung`; the label is copy',
  'restated-hold': 'call `isUsageLimitHold(run)` from the contract\'s waits module',
  'resume-time-read': 'decide through `isUsageLimitHold`, or add the file to packages/cezar/src/lint/resume-time-readers.json with its reason',
};

const HOLD_WINDOW = 160;
interface ResumeAccess { start: number; end: number; node: EsNode }

const firstStatus = new WeakMap<EsNode, EsNode | undefined>();
const lastStatus = new WeakMap<EsNode, EsNode | undefined>();

/** The old comparison starts or ends at the first/last `.status` inside an operand.
 * Cache each subtree once per direction; nested operands must not cause repeated walks. */
function operandStatus(node: EsNode, first: boolean): EsNode | undefined {
  const cache = first ? firstStatus : lastStatus;
  if (cache.has(node)) return cache.get(node);
  const members: EsNode[] = [];
  if (node.type === 'MemberExpression' && !node.computed && propertyName(node) === 'status') members.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const one = child(node, key);
    for (const item of one ? [one] : children(node, key)) {
      const status = operandStatus(item, first);
      if (status) members.push(status);
    }
  }
  const result = members.reduce<EsNode | undefined>((edge, member) => {
    if (!edge) return member;
    const earlier = offset(child(member, 'property')!) < offset(child(edge, 'property')!);
    return earlier === first ? member : edge;
  }, undefined);
  cache.set(node, result);
  return result;
}

/** Identify waiting comparisons; their parents may be casts, calls or other expressions. */
function waitingStatus(node: EsNode): EsNode | undefined {
  if (node.type !== 'BinaryExpression' || !['===', '!=='].includes(String(node.operator))) return undefined;
  const left = child(node, 'left')!, right = child(node, 'right')!;
  return literal(left) === 'waiting' ? operandStatus(right, true)
    : literal(right) === 'waiting' ? operandStatus(left, false) : undefined;
}

/** ESTree erases parentheses and decodes literals. Keep the old scanner's operand spelling.
 * Inspect only the token gap inside this comparison; comments were whitespace in the old scan. */
function scannerWaitingComparison(node: EsNode, status: EsNode, source: string, code: string): boolean {
  const left = child(node, 'left')!, right = child(node, 'right')!;
  const reversed = literal(left) === 'waiting';
  const quoted = unwrap(reversed ? left : right)!;
  if (quoted.type !== 'Literal') return false;
  const [quoteStart, quoteEnd] = quoted.range as [number, number];
  if (!["'waiting'", '"waiting"'].includes(source.slice(quoteStart, quoteEnd))) return false;
  const property = child(status, 'property')!;
  const [propertyStart, propertyEnd] = property.range as [number, number];
  if (property.type !== 'Identifier' || source.slice(propertyStart, propertyEnd) !== 'status' || source.charAt(propertyStart - 1) !== '.') return false;
  const gap = reversed ? code.slice(quoteEnd, propertyStart) : code.slice(propertyEnd, quoteStart);
  return reversed ? /^\s*(?:===|!==)\s*[\w$.?]*\.$/.test(gap) : /^\s*(?:===|!==)\s*$/.test(gap);
}

/** The original lookaround starts at .status (or the left literal), and ends at its other side. */
function waitingBounds(node: EsNode): { start: number; end: number } {
  const status = waitingStatus(node)!;
  const left = child(node, 'left')!, right = child(node, 'right')!;
  const reversed = literal(left) === 'waiting';
  const property = child(status, 'property')!;
  const end = (reversed ? property : unwrap(right)!).range as [number, number];
  return {
    start: reversed ? offset(left) : offset(property) - 1,
    end: end[1],
  };
}

/** First resume access at or after an offset. Access tokens do not overlap. */
function resumeIndex(resumes: ResumeAccess[], at: number): number {
  let low = 0, high = resumes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (resumes[middle]!.start < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Match the original nearest-access windows on bounded slices, regardless of AST ancestry.
 * A gap needs logical text and no semicolon or brace. The full access must fit the window. */
function joinedResume(code: string, at: { start: number; end: number }, resumes: ResumeAccess[]): boolean {
  const joined = (between: string) => /&&|\|\|/.test(between) && !/[;{}]/.test(between);
  const after = resumes[resumeIndex(resumes, at.end)];
  if (after && after.end <= at.end + HOLD_WINDOW && joined(code.slice(at.end, after.start))) return true;
  const before = resumes[resumeIndex(resumes, at.start) - 1];
  return before !== undefined && before.start >= at.start - HOLD_WINDOW
    && before.end <= at.start && joined(code.slice(before.end, at.start));
}

export const runFactReader: AstRule = {
  name: 'run-fact-reader',
  description: 'Read run facts from the contract: attention rungs, `isUsageLimitHold`, listed resume-time readers (hearsay-tools/cezarion#1496).',
  applies: scanned,
  create(report, { file, sourceCode }) {
    const sites: Record<Rule, EsNode[]> = { 'label-comparison': [], 'restated-hold': [], 'resume-time-read': [] };
    const attention = (node: EsNode | undefined): boolean => {
      node = unwrap(node);
      if (!node) return false;
      if (node.type === 'CallExpression') return propertyName(child(node, 'callee')) === 'deriveAttention';
      return /[aA]ttention$/.test(propertyName(node) ?? '');
    };
    const compares = (node: EsNode): boolean => {
      let parent = node.parent;
      while (parent?.type === 'ChainExpression') { node = parent; parent = parent.parent; }
      if (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(String(parent.operator))) return true;
      if (parent?.type === 'SwitchStatement' && child(parent, 'discriminant') === node) return true;
      return parent?.type === 'MemberExpression' && !parent.computed && ['startsWith', 'endsWith', 'includes', 'toLowerCase', 'toUpperCase', 'match', 'localeCompare'].includes(propertyName(parent) ?? '');
    };
    // Blanking reads the whole file; only a `'waiting'` comparison needs it.
    let blanked: string | undefined;
    const code = () => (blanked ??= blankOnce(sourceCode.text));
    const resumes: ResumeAccess[] = [];
    const waitingNodes: EsNode[] = [];
    return {
      MemberExpression(node) {
        if (node.computed) return;
        const key = propertyName(node);
        if (!file.startsWith(HOME) && key === 'label' && attention(child(node, 'object')) && compares(node)) sites['label-comparison'].push(child(node, 'property')!);
        if (isTest(file) || key !== 'autoResumeAt') return;
        const property = child(node, 'property')!;
        const [start, end] = property.range as [number, number];
        if (sourceCode.text.slice(start, end) === 'autoResumeAt' && sourceCode.text.charAt(start - 1) === '.') {
          resumes.push({ start: start - 1, end, node: property });
        }
      },
      BinaryExpression(node) {
        if (file.startsWith(HOME) || isTest(file)) return;
        const status = waitingStatus(node);
        if (status && scannerWaitingComparison(node, status, sourceCode.text, code())) waitingNodes.push(node);
      },
      'Program:exit'() {
        resumes.sort((a, b) => a.start - b.start);
        if (resumes.length && !(file in (listed ??= readReaders()))) sites['resume-time-read'].push(resumes[0]!.node);
        for (const node of waitingNodes) {
          if (!joinedResume(code(), waitingBounds(node), resumes)) continue;
          const status = waitingStatus(node)!;
          const left = child(node, 'left')!;
          sites['restated-hold'].push(literal(left) === 'waiting' ? left : child(status, 'property')!);
        }
        if (!sites['label-comparison'].length && !sites['restated-hold'].length && !sites['resume-time-read'].length) return;
        const lines = sourceCode.text.split('\n');
        for (const rule of ['label-comparison', 'restated-hold', 'resume-time-read'] as const) for (const node of sites[rule]) {
          const text = lines[nodeLine(node) - 1]!.trim();
          report(node, `${rule}: ${text} — ${HOW[rule]} (hearsay-tools/cezarion#1496).`);
        }
      },
    };
  },
};
