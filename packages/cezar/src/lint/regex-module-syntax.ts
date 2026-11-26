import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';

/**
 * A scan that classifies JS/TS module syntax reads a syntax tree, not a regular expression
 * (hearsay-tools/squawk#4296). Regex import scanners did not converge in review: each round found
 * another form they missed, such as a template literal, `import()`, `import x = require()` or a
 * comment, until the scan moved to an AST.
 *
 * Static scope: every JS and TS file under `packages/`, tests and testkits included. The rule
 * reads a regex literal, and the first argument of `new RegExp(…)` or `RegExp(…)` when it is a
 * string literal, a template literal (its static parts) or a `String.raw` template. It reports a
 * pattern in which `import`, `export`, `require` or `from` stands as a whole word next to a regex
 * token or code punctuation: `\s`, `\b`, a group, a brace, `*`, a quote, a character class,
 * `\.meta`, or after one space a quote, a brace, `*`, `(` or a declaration keyword. A keyword that
 * is one alternative of a group, as in `(?:import|export)`, is syntax too. So is a keyword at a line
 * start (`^`, `\n`, `(?:^|\n)`, then optional `\s`, `[ \t]` or space tokens with `*`, `+` or `?`),
 * unless one space and a word follow it.
 *
 * It leaves out prose (the keyword, one space and a word, as in "files import the changed files"),
 * a keyword after `-` or `@` (`--import`, CSS `@import`) or before `-` (`require-e2e`), a line start
 * with other white space forms (`\t*`, `[\t ]*`, `\s{0,4}`, ` {2}`), `^import x from` (one space and a
 * word read as prose), and a pattern built from parts: a variable, `+` concatenation or a call. Those are accepted limits of a
 * syntax rule (docs/sdlc/lint.md § New safety guards).
 */

const MESSAGE =
  'A regular expression that matches JS/TS module syntax (import, export, require, from) misses forms such as ' +
  'template literals, import(), import x = require() and comments. Read the syntax tree instead: runtimeImports or ' +
  'moduleImports in packages/cezar/src/core/module-imports.testkit.ts, an oxlint AST visitor, or @babel/parser. ' +
  'Regular expressions are for plain text only (hearsay-tools/squawk#4296).';

const KEYWORDS = ['import', 'export', 'require', 'from'];
const KEYWORD = new RegExp(`(?:${KEYWORDS.join('|')})(?!\\w)`, 'g');
/** A character class that holds a quote or white space, such as `['"]` or `[ \t]`. */
const CLASS = String.raw`\[\^?(?:[^\]]*['"\x60]|[ \\]\\?[st ])`;
/** What makes the keyword code when it follows with no space. */
const SYNTAX_NEXT = new RegExp(String.raw`^(?:\\[sb({*.]|[({*'"\x60]|${CLASS})`);
/** What makes the keyword code after one literal space. */
const SYNTAX_AFTER_SPACE = new RegExp(String.raw`^ (?:\\[({*]|[{*'"\x60(]|\[\^?[^\]]*['"\x60]|(?:type|const|let|var|default|function|async|class|declare|interface)\b)`);
/** A line start, `^`, `\n` or a group such as `(?:^|\n)`, then optional white space tokens. */
const LINE_START = /(?:(?:^|[^\\])\^|\\n|(?:\^|\\n)\))(?:\\s[*+?]?|\[ \\t\][*+?]?| [*+?]?)*$/;
/** One space and a word: the keyword reads as prose, as in `^from the start`. */
const PROSE_NEXT = /^ [A-Za-z]/;
/** Zero-width tokens and anchors that may stand between a group's start and its alternative. */
const LEADING_TOKENS = /(?:\\[bs][*+?]?|\^)*$/;

/** Whether the keyword at `at` starts a word: no word character before it, or a regex escape such as `\b`. */
function startsWord(source: string, at: number): boolean {
  if (at === 0 || !/[\w$]/.test(source.charAt(at - 1))) return true;
  return source.charAt(at - 2) === '\\' && /[bsSwWdDtn]/.test(source.charAt(at - 1));
}

/** Whether one keyword at `at`, `length` long, reads as code in the regex `source`. */
function keywordIsSyntax(source: string, at: number, length: number): boolean {
  if (!startsWord(source, at)) return false;
  const before = source.charAt(at - 1);
  const next = source.slice(at + length);
  if (before === '-' || before === '@' || next.startsWith('-')) return false;
  // One alternative of a group, such as `(?:import|load)` or `(?:\bfrom|^import)`.
  if (/^[|)]/.test(next) && /[|(:]$/.test(source.slice(0, at).replace(LEADING_TOKENS, ''))) return true;
  // A keyword at a line start is a statement keyword unless one space and a prose word follow it.
  if (LINE_START.test(source.slice(0, at)) && !PROSE_NEXT.test(next)) return true;
  return SYNTAX_NEXT.test(next) || SYNTAX_AFTER_SPACE.test(next);
}

/** Whether a regex source matches JS/TS module syntax. */
export function matchesModuleSyntax(source: string): boolean {
  for (const match of source.matchAll(KEYWORD)) {
    if (keywordIsSyntax(source, match.index, match[0].length)) return true;
  }
  return false;
}

/** The static text of a `RegExp` pattern argument; `\0` stands where a substitution was. */
function patternOf(node: EsNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'TemplateLiteral') {
    return children(node, 'quasis').map(quasi => (quasi.value as { cooked?: string } | undefined)?.cooked ?? '').join('\0');
  }
  if (node.type === 'TaggedTemplateExpression') {
    const tag = child(node, 'tag');
    const raw = tag?.type === 'MemberExpression' && nameOf(child(tag, 'object')) === 'String' && nameOf(child(tag, 'property')) === 'raw';
    const quasi = child(node, 'quasi');
    if (!raw || !quasi) return undefined;
    return children(quasi, 'quasis').map(part => (part.value as { raw?: string } | undefined)?.raw ?? '').join('\0');
  }
  return stringOf(node);
}

function checkRegExpCall(node: EsNode, report: (node: EsNode, message: string) => void): void {
  if (nameOf(child(node, 'callee')) !== 'RegExp') return;
  const pattern = patternOf(children(node, 'arguments')[0]);
  if (pattern !== undefined && matchesModuleSyntax(pattern)) report(node, MESSAGE);
}

export const regexModuleSyntax: AstRule = {
  name: 'regex-module-syntax',
  description: 'Classify JS/TS module syntax with a syntax tree, not a regular expression (hearsay-tools/squawk#4296).',
  applies: file => /^packages\/.+\.[cm]?[jt]sx?$/.test(file),
  create: report => ({
    Literal(node) {
      const regex = node.regex as { pattern?: unknown } | undefined;
      if (typeof regex?.pattern === 'string' && matchesModuleSyntax(regex.pattern)) report(node, MESSAGE);
    },
    NewExpression: node => checkRegExpCall(node, report),
    CallExpression: node => checkRegExpCall(node, report),
  }),
};
