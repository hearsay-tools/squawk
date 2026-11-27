import { child, children, nameOf, stringOf, type AstRule, type EsNode, type Report, type Visitors } from './ast-rule.ts';

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

/** Utility tokens that override PageShellActionButton's unified header button height. */
const ACTION_OVERRIDE_TOKEN = /^(?:(?:sm|md|lg|xl|2xl|max-[a-z0-9-]+):)*(?:h-|min-h-|max-h-|size-|py-|pt-|pb-)\S+$/;

const SHELL_STYLE_PROPS = new Set([
  'maxWidth',
  'maxInlineSize',
  'padding',
  'paddingInline',
  'paddingInlineStart',
  'paddingInlineEnd',
  'paddingLeft',
  'paddingRight',
  'marginInline',
  'marginInlineStart',
  'marginInlineEnd',
  '--page-shell-max-w',
  '--page-shell-gutter',
]);

const ACTION_STYLE_PROPS = new Set([
  'height',
  'minHeight',
  'maxHeight',
  'blockSize',
  'minBlockSize',
  'maxBlockSize',
  'padding',
  'paddingBlock',
  'paddingBlockStart',
  'paddingBlockEnd',
  'paddingTop',
  'paddingBottom',
  'fontSize',
]);

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

function firstMatchingToken(attr: EsNode | undefined, pattern: RegExp): string | undefined {
  if (!attr) return undefined;
  for (const text of staticStrings(child(attr, 'value'))) {
    for (const token of text.trim().split(/\s+/)) {
      if (token && pattern.test(token)) return token;
    }
  }
  return undefined;
}

function firstStyleKey(attr: EsNode | undefined, forbidden: Set<string>): string | undefined {
  if (!attr) return undefined;
  let expr = child(attr, 'value');
  if (expr?.type === 'JSXExpressionContainer') expr = child(expr, 'expression');
  while (expr && (expr.type === 'TSAsExpression' || expr.type === 'TSSatisfiesExpression' || expr.type === 'TSNonNullExpression')) {
    expr = child(expr, 'expression');
  }
  if (expr?.type !== 'ObjectExpression') return undefined;
  for (const prop of children(expr, 'properties')) {
    if (prop.type !== 'Property') continue;
    const keyNode = child(prop, 'key');
    const key = prop.computed ? stringOf(keyNode) : (nameOf(keyNode) ?? stringOf(keyNode));
    if (key && forbidden.has(key)) return key;
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

function checkShellOverrides(node: EsNode, tag: string, report: Report): void {
  const override = firstMatchingToken(findAttr(node, 'className'), SHELL_OVERRIDE_TOKEN)
    ?? firstMatchingToken(findAttr(node, 'bodyClassName'), SHELL_OVERRIDE_TOKEN)
    ?? firstStyleKey(findAttr(node, 'style'), SHELL_STYLE_PROPS);
  if (override) {
    report(
      node,
      `Do not override PageShell width, horizontal padding, or centering ("${override}") on <${tag}>; let the named template own layout geometry → ${OWNER}`,
    );
  }
}

function checkActionOverrides(node: EsNode, report: Report): void {
  if (findAttr(node, 'size')) {
    report(
      node,
      `Do not pass size to <PageShellActionButton>; PageShell owns the unified header button height → ${OWNER}`,
    );
    return;
  }
  const override = firstMatchingToken(findAttr(node, 'className'), ACTION_OVERRIDE_TOKEN)
    ?? firstStyleKey(findAttr(node, 'style'), ACTION_STYLE_PROPS);
  if (override) {
    report(
      node,
      `Do not override header button sizing ("${override}") on <PageShellActionButton>; PageShell owns the unified header button height → ${OWNER}`,
    );
  }
}

/**
 * Blocks route-level width, gutter, header-button sizing, and ad-hoc page-header overrides
 * outside the shared PageShell templates (hearsay-tools/squawk#4373).
 */
export const pageShellOverride: AstRule = {
  name: 'page-shell-override',
  description: 'Route files must use named PageShell templates without overriding shell width, gutter, header button height, or page header markup',
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
          checkShellOverrides(node, tag, report);
          return;
        }

        if (tag === 'PageShellActionButton') {
          checkActionOverrides(node, report);
        }
      },
    };
  },
};
