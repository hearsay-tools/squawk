import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardianFile, guardianFindings } from './design-guardian.ts';
import { repoRoot } from './source-rule.ts';

/** Stylesheets oxlint cannot read, including nested styles and e2e fixtures. */
export function guardianCssFiles(root: string, rel = 'packages/web'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...guardianCssFiles(root, file));
    else if (file.endsWith('.css')) out.push(file);
  }
  return out;
}

/** The original stylesheet status-key check; StatusDot and Pill own their appearance. */
export function statusStyleProblems(file: string, source: string): string[] {
  const input = guardianFile(file, source);
  if (!input || input.ext !== '.css') return [];
  // The dot's tone and shape are the status; a sheet that hides the dot (or paints a done pill
  // as a teal chip) replaces the key with a second, surface-local one. StatusDot and Pill own
  // their look; a sheet may only position them.
  const offenders: string[] = [];
  const css = input.lines.join('\n');
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim(), body = match[2]!;
    const dot = /data-slot=["']status-dot["']/.test(selector);
    const statusPill = /\[data-status=[^\]]+\][^,{]*\[data-slot=["']pill["']\]/.test(selector);
    if ((dot && /display:\s*none|background|color|width|height/.test(body)) ||
        (statusPill && /background|color:|display:\s*none/.test(body))) {
      offenders.push(`${file}: ${selector.replace(/\s+/g, ' ')}`);
    }
  }
  return offenders;
}

/** Route stylesheets must not override PageShell width, gutter, or header button sizing. */
export function pageShellStyleProblems(file: string, source: string): string[] {
  if (!file.startsWith('packages/web/src/routes/') || !file.endsWith('.css')) return [];
  const input = guardianFile(file, source);
  if (!input || input.ext !== '.css') return [];
  const offenders: string[] = [];
  const css = input.lines.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const shellSlot = /data-slot=["']page-shell(?:-(?:frame|header|header-title|header-actions))?["']/;
  const shellProp = /--page-shell-(?:max-w|gutter)|(?:^|[;\s])(?:max-width|max-inline-size|width|inline-size|padding(?:-(?:inline|block|left|right|top|bottom|inline-start|inline-end|block-start|block-end))?|margin-inline(?:-(?:start|end))?|margin-left|margin-right|height|min-height|max-height|block-size|min-block-size|max-block-size|font-size)\s*:/;
  const routeRoot = /(?:^|,)\s*\[data-route=[^\]]+\](?:\[[^\]]+\])*\s*(?:,|$)/;
  const routeRootProp = /(?:^|[;\s])(?:max-width|max-inline-size|padding-inline(?:-(?:start|end))?|padding-left|padding-right|margin-inline(?:-(?:start|end))?|margin-left|margin-right)\s*:/;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim(), body = match[2]!;
    if ((shellSlot.test(selector) && shellProp.test(body))
        || (routeRoot.test(selector) && routeRootProp.test(body))) {
      offenders.push(`${file}: ${selector.replace(/\s+/g, ' ')} page-shell-style: PageShell owns shell width, gutter, and header sizing → hearsay-tools/squawk#4373`);
    }
  }
  return offenders;
}

/** Same guardian rules and messages for the CSS files outside oxlint's language set. */
export function guardianCssProblems(root = repoRoot): string[] {
  const files = ['src', 'e2e'].flatMap((dir) => guardianCssFiles(root, `packages/web/${dir}`));
  return files.flatMap((file) => {
    const source = readFileSync(join(root, file), 'utf8');
    return [
      ...guardianFindings(file, source).map((finding) => `${file}:${finding.line}:${(finding.column ?? 0) + 1} cez/design-guardian: ${finding.message}`),
      ...statusStyleProblems(file, source).map((problem) => `${problem} status-style: StatusDot and Pill own their look → hearsay-tools/cezarion#2422`),
      ...pageShellStyleProblems(file, source),
    ];
  });
}
