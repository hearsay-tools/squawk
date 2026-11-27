import { child, children, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';

const OWNER = 'hearsay-tools/squawk#4373';

/** Sticky task/report chrome owns its own document heading outside the five PageShell templates. */
const EXEMPT_HEADER_FILES = new Set([
  'packages/web/src/routes/task-thread/run-header.tsx',
  'packages/web/src/routes/task-git/report-reader.tsx',
]);

const SHELL_COMPONENTS = new Set([
  'PageShell',
  'TablePage',
  'SplitPage',
  'ReadingPage',
  'FormPage',
  'BoardPage',
]);

const PAGE_HEADER_SLOTS = new Set([
  'page-header',
  'page-shell-header',
  'plan-page-header',
  'gh-masthead',
  'repo-header',
  'settings-main-header',
]);

/** Utility tokens that override PageShell's shared max-width, gutter, or left-aligned origin. */
const SHELL_OVERRIDE_TOKEN = /^(?:(?:sm|md|lg|xl|2xl|max-[a-z0-9-]+):)*(?:max-w-(?!full$)\S+|mx-auto|px-\S+|pl-\S+|pr-\S+)$/;

function jsxTagName(opening: EsNode): string | undefined {
  const name = child(opening, 'name');
  if (name?.type === 'JSXIdentifier' && typeof name.name === 'string') return name.name;
  return undefined;
}

function jsxAttrName(attr: EsNode): string | undefined {
  if (attr.type !== 'JSXAttribute') return undefined;
  const name = child(attr, 'name');
  if (name?.type === 'JSXIdentifier' && typeof name.name === 'string') return name.name;
  return undefined;
}

function findAttr(opening: EsNode, target: string): EsNode | undefined {
  return children(opening, 'attributes').find((attr) => jsxAttrName(attr) === target);
}

function staticStrings(node: EsNode | undefined): string[] {
  if (!node) return [];
  if (node.type === 'Literal') {
    const value = stringOf(node);
    return value ? [value] : [];
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = children(node, 'quasis')
      .map((quasi) => {
        const value = quasi.value as { cooked?: unknown } | undefined;
        return typeof value?.cooked === 'string' ? value.cooked : '';
      })
      .filter(Boolean);
    const exprs = children(node, 'expressions').flatMap(staticStrings);
    return [...quasis, ...exprs];
  }
  if (
    node.type === 'JSXExpressionContainer'
    || node.type === 'TSAsExpression'
    || node.type === 'TSSatisfiesExpression'
    || node.type === 'TSNonNullExpression'
  ) {
    return staticStrings(child(node, 'expression'));
  }
  if (node.type === 'ConditionalExpression') {
    return [...staticStrings(child(node, 'consequent')), ...staticStrings(child(node, 'alternate'))];
  }
  if (node.type === 'LogicalExpression') {
    return [...staticStrings(child(node, 'left')), ...staticStrings(child(node, 'right'))];
  }
  if (node.type === 'CallExpression') {
    return children(node, 'arguments').flatMap(staticStrings);
  }
  if (node.type === 'ArrayExpression') {
    return (Array.isArray(node.elements) ? node.elements : []).flatMap((item) =>
      staticStrings(item as EsNode | undefined),
    );
  }
  return [];
}

function firstOverrideToken(attr: EsNode | undefined): string | undefined {
  if (!attr) return undefined;
  for (const text of staticStrings(child(attr, 'value'))) {
    for (const token of text.trim().split(/\s+/)) {
      if (token && SHELL_OVERRIDE_TOKEN.test(token)) return token;
    }
  }
  return undefined;
}

function attrStaticString(attr: EsNode | undefined): string | undefined {
  if (!attr) return undefined;
  const value = child(attr, 'value');
  if (!value) return undefined;
  if (value.type === 'Literal') return stringOf(value);
  if (value.type === 'JSXExpressionContainer') return stringOf(child(value, 'expression'));
  return undefined;
}

/**
 * Blocks route-level width, gutter, and ad-hoc page-header overrides outside the shared
 * PageShell templates (hearsay-tools/squawk#4373).
 */
export const pageShellOverride: AstRule = {
  name: 'page-shell-override',
  description: 'Route files must use named PageShell templates without overriding shell width, gutter, or page header markup',
  applies: (file) =>
    file.startsWith('packages/web/src/routes/')
    && file.endsWith('.tsx')
    && !/\.(?:test|testkit)\.tsx$/.test(file),
  create(report, context): Visitors {
    const exempt = EXEMPT_HEADER_FILES.has(context.file);
    return {
      JSXOpeningElement(node) {
        const tag = jsxTagName(node);
        if (!tag) return;

        if (!exempt && tag === 'h1') {
          report(
            node,
            `Route files must render page headings through PageShell (TablePage, SplitPage, ReadingPage, FormPage, or BoardPage) instead of a raw <h1> → ${OWNER}`,
          );
          return;
        }

        if (!exempt && /^[a-z]/.test(tag) && findAttr(node, 'data-route')) {
          report(
            node,
            `Route roots must render through a named PageShell template instead of setting data-route on a raw <${tag}> → ${OWNER}`,
          );
          return;
        }

        if (!exempt && tag === 'header') {
          const slot = attrStaticString(findAttr(node, 'data-slot'));
          if (slot && PAGE_HEADER_SLOTS.has(slot)) {
            report(
              node,
              `Route page headers must use PageShell header slots instead of ad-hoc <header data-slot="${slot}"> markup → ${OWNER}`,
            );
          }
          return;
        }

        if (SHELL_COMPONENTS.has(tag)) {
          const override = firstOverrideToken(findAttr(node, 'className'))
            ?? firstOverrideToken(findAttr(node, 'bodyClassName'));
          if (override) {
            report(
              node,
              `Do not override PageShell width, horizontal padding, or centering ("${override}") on <${tag}>; let the named template own layout geometry → ${OWNER}`,
            );
          }
        }
      },
    };
  },
};
