type FrontmatterValue = string | string[];

/** The leading `---\n … \n---` block and the body after it, or undefined when raw has no block. */
function frontmatterBlock(raw: string): { block: string; body: string } | undefined {
  // Normalize CRLF and lone CR — otherwise frontmatter is silently dropped.
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return undefined;

  // Match the closing delimiter only on its own line so a `---` thematic
  // break inside the body doesn't terminate the block early.
  const end = text.indexOf('\n---\n', 4);
  const endAtEof = text.endsWith('\n---') ? text.length - 4 : -1;
  const closeAt = end === -1 ? endAtEof : end;
  if (closeAt === -1) return undefined;

  const block = text.slice(4, closeAt);
  const afterDelimiter = end === -1 ? -1 : text.indexOf('\n', closeAt + 1);
  const body = afterDelimiter === -1 ? '' : text.slice(afterDelimiter + 1);
  return { block, body };
}

/**
 * Tiny purpose-built frontmatter parser — a leading `---\n … \n---\n` block
 * with `key: value` lines, `key: [a, b]` inline arrays and `key:` + `  - a`
 * block arrays. Deliberately not full YAML so we avoid a parser dependency
 * for skill files.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
} {
  const parsed = frontmatterBlock(raw);
  if (!parsed) return { frontmatter: {}, body: raw };
  return { frontmatter: parseFrontmatterEntries(parsed.block), body: parsed.body };
}

/** Parses the block's `key: value`, `key: [a, b]` and `key:` + block-array lines. */
function parseFrontmatterEntries(block: string): Record<string, FrontmatterValue> {
  const frontmatter: Record<string, FrontmatterValue> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    i = parseFrontmatterEntry(frontmatter, m[1] as string, (m[2] ?? '').trim(), lines, i);
  }
  return frontmatter;
}

/** One `key:` line plus any block-array items under it; returns the last line index consumed. */
function parseFrontmatterEntry(
  frontmatter: Record<string, FrontmatterValue>,
  key: string,
  rest: string,
  lines: string[],
  i: number,
): number {
  if (rest === '') return collectBlockItems(frontmatter, key, lines, i);

  if (rest.startsWith('[') && rest.endsWith(']')) {
    frontmatter[key] = inlineListItems(rest);
    return i;
  }

  frontmatter[key] = stripQuotes(rest);
  return i;
}

/** The `key:` + `  - a` form: every following dashed line joins the list. */
function collectBlockItems(
  frontmatter: Record<string, FrontmatterValue>,
  key: string,
  lines: string[],
  i: number,
): number {
  const items: string[] = [];
  while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1] ?? '')) {
    items.push(stripQuotes((lines[i + 1] ?? '').replace(/^\s*-\s+/, '').trim()));
    i++;
  }
  frontmatter[key] = items;
  return i;
}

/** The `key: [a, b]` inline form; an empty `[]` yields an empty list. */
function inlineListItems(rest: string): FrontmatterValue {
  const inner = rest.slice(1, -1).trim();
  return inner
    ? inner
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0)
    : [];
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
