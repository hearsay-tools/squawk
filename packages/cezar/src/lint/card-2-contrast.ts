import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { repoRoot } from './source-rule.ts'
import { child, children, nameOf, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts'

export const WEB_SRC = 'packages/web/src/'
export const baselineFile = 'packages/web/src/test/card-2-contrast.baseline.json'
export const readContrastBaseline = (root = repoRoot): string[] => JSON.parse(readFileSync(join(root, baselineFile), 'utf8')) as string[]

let surfaces: Set<string> | undefined
// Only named palette colors establish an opaque surface. Unknown arbitrary images,
// gradients and layout utilities retain the ancestor surface conservatively.
export function paletteSurfaces(): Set<string> {
  return surfaces ??= new Set([
    ...Array.from(readFileSync(join(repoRoot, WEB_SRC, 'styles/index.css'), 'utf8').matchAll(/--color-([\w-]+):/g), m => `bg-${m[1]}`),
    'bg-black', 'bg-white',
  ])
}

/** Static guard, not a computed-style audit. Unknown sizes are conservatively small.
 * Literal branches in cn()/templates are inspected; arbitrary runtime class values are not. */
function eachChild(node: EsNode, visit: (node: EsNode) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item === 'object' && typeof item.type === 'string') visit(item as EsNode)
    }
  }
}

/** Preserve empty alternatives and bound class expansion, as in the original guard. */
function classBranches(node: EsNode | undefined): string[] {
  if (!node) return ['']
  const combine = (groups: string[][], separator = ' '): string[] => groups.reduce((left, right) => {
    if (left.length * right.length > 128) return [[...left, ...right, 'text-xs'].join(' ')]
    return [...new Set(left.flatMap(a => right.map(b => a + separator + b)))]
  }, [''])
  switch (node.type) {
    case 'Literal': return [stringOf(node) ?? '']
    case 'JSXExpressionContainer': case 'TSAsExpression': case 'TSSatisfiesExpression':
    case 'TSNonNullExpression': return classBranches(child(node, 'expression'))
    case 'SpreadElement': return classBranches(child(node, 'argument'))
    case 'ConditionalExpression': return [...classBranches(child(node, 'consequent')), ...classBranches(child(node, 'alternate'))]
    case 'LogicalExpression': return ['', ...classBranches(child(node, 'left')), ...classBranches(child(node, 'right'))]
    case 'CallExpression': return combine(children(node, 'arguments').map(classBranches))
    case 'ArrayExpression': return combine((Array.isArray(node.elements) ? node.elements : []).map(item => classBranches(item as EsNode | undefined)))
    case 'TemplateLiteral': {
      const expressions = children(node, 'expressions')
      return combine(children(node, 'quasis').flatMap((q, i) => {
        const raw = (q.value as { raw: string }).raw
        return i < expressions.length ? [[raw], classBranches(expressions[i])] : [[raw]]
      }), '')
    }
    case 'ObjectExpression': return combine(children(node, 'properties').map(p => p.type === 'Property' && !p.computed
      ? ['', stringOf(child(p, 'key')) ?? nameOf(child(p, 'key')) ?? ''] : ['']))
    default: return ['']
  }
}

/** Only a falsy number survives React's && short circuit as visible text. */
function mayRenderFalsyNumber(node: EsNode | undefined): boolean {
  if (!node) return false
  switch (node.type) {
    case 'Literal': return typeof node.value === 'number' && node.value === 0
    case 'JSXElement': case 'JSXFragment': return false
    case 'UnaryExpression': return !['!', 'void', 'typeof', 'delete'].includes(String(node.operator))
    case 'BinaryExpression': return !['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(String(node.operator))
    default: return true
  }
}

/** JSX branches are visited separately; only rendered text belongs to the wrapper. */
function rendersText(node: EsNode | undefined): boolean {
  if (!node) return false
  switch (node.type) {
    case 'JSXText': return String(node.value).trim() !== ''
    case 'JSXFragment': return children(node, 'children').some(rendersText)
    case 'JSXElement': case 'JSXEmptyExpression': return false
    case 'Literal': return node.value !== null && typeof node.value !== 'boolean'
    case 'JSXExpressionContainer': case 'TSAsExpression': case 'TSSatisfiesExpression':
    case 'TSNonNullExpression': return rendersText(child(node, 'expression'))
    case 'BinaryExpression': return !['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(String(node.operator))
    case 'UnaryExpression': return !['!', 'delete', 'void'].includes(String(node.operator))
    case 'ConditionalExpression': return rendersText(child(node, 'consequent')) || rendersText(child(node, 'alternate'))
    case 'LogicalExpression': return (node.operator === '&&' ? mayRenderFalsyNumber(child(node, 'left')) : rendersText(child(node, 'left'))) || rendersText(child(node, 'right'))
    default: return true
  }
}

/** Keep the default state and a union of possible variant ink/size changes.
 * Variant surfaces cannot guarantee opacity in every state, so only card-2 is
 * added to the union. This deliberately favors findings over unsafe exemptions. */
function utilityStates(branch: string): string[][] {
  const base: string[] = []
  const variants: string[] = []
  for (const token of branch.split(/\s+/)) {
    let depth = 0
    let lastColon = -1
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '[' || token[i] === '(') depth++
      else if (token[i] === ']' || token[i] === ')') depth--
      else if (token[i] === ':' && depth === 0) lastColon = i
    }
    const utility = token.slice(lastColon + 1).replace(/^!|!$/g, '')
      .replace(/^(bg-[^/]+)\/(?:100(?:\.0+)?|\[1(?:\.0+)?\]|\[100(?:\.0+)?%\])$/, '$1')
    if (lastColon === -1) base.push(utility)
    else {
      if (utility.startsWith('text-') || utility.startsWith('font-') || utility === 'bg-card-2') variants.push(utility)
    }
  }
  return variants.length ? [base, [...base, ...variants]] : [base]
}

const namedSizes: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 }
function fontSize(utility: string): number {
  const value = utility.slice(5).split('/')[0] ?? ''
  const pixels = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value)
  return pixels ? Number(pixels[1]) : namedSizes[value] ?? 0 // unknown explicit size is conservatively small
}

interface ContrastState { onCard: boolean; unsafeInk: boolean; size: number; bold: boolean; large: boolean }
const unsafe = (ink: string) => ['text-danger', 'text-destructive', 'text-soft-foreground', 'text-pending-strong'].includes(ink)
const initialState: ContrastState = { onCard: false, unsafeInk: false, size: 0, bold: false, large: false }

interface ClassOverrides {
  hasCard2: boolean
  inheritsSurface: boolean
  ownUnsafe: boolean | undefined
  ownSize: number | undefined
  ownBold: boolean | undefined
}

function classOverrides(classes: string[], surfaceClasses: Set<string>): ClassOverrides {
  const backgrounds = classes.filter(c => surfaceClasses.has(c) || c === 'bg-transparent' || surfaceClasses.has(c.split('/')[0] ?? ''))
  const inheritsSurface = backgrounds.length === 0 || backgrounds.some(c => c === 'bg-transparent' || c.includes('/'))
  const ownColors = classes
    .map(c => c.replace(/^(text-(?:danger|destructive|soft-foreground|pending-strong))\/.+$/, '$1'))
    .filter(c => /^text-(?:danger|destructive|soft-foreground|pending-strong|muted-foreground|supporting-foreground|link-foreground|foreground|signal-word-red|signal-word-amber)$/.test(c))
  const sizes = classes.filter(c => /^text-(?:xs|sm|base|lg|xl|\d+xl)(?:\/.*)?$|^text-(?:\[|\(length:)/.test(c))
  const weights = classes.filter(c => /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$|^font-(?:\[|\(weight:)/.test(c))
  return {
    hasCard2: backgrounds.includes('bg-card-2'),
    inheritsSurface,
    ownUnsafe: ownColors.length ? ownColors.some(unsafe) : undefined,
    ownSize: sizes.length ? Math.min(...sizes.map(fontSize)) : undefined,
    ownBold: weights.length ? weights.every(w => /^font-(?:bold|extrabold|black)$/.test(w)) : undefined,
  }
}

function applyOverrides(parent: ContrastState, overrides: ClassOverrides, bodySlot: boolean): ContrastState {
  const onCard = overrides.hasCard2 || (overrides.inheritsSurface && (parent.onCard || bodySlot))
  const unsafeInk = overrides.ownUnsafe ?? parent.unsafeInk
  const size = overrides.ownSize ?? parent.size
  const bold = overrides.ownBold ?? parent.bold
  return { onCard, unsafeInk, size, bold, large: size >= 24 || (bold && size >= 56 / 3) }
}

function stateKey(state: ContrastState): string {
  const sizeBand = state.size >= 24 ? 2 : state.size >= 56 / 3 ? 1 : 0
  return `${state.onCard ? 1 : 0}${state.unsafeInk ? 1 : 0}${sizeBand}${state.bold ? 1 : 0}`
}

function nodeStrings(n: EsNode | undefined): string[] {
  if (!n) return []
  if (n.type === 'Literal') return typeof n.value === 'string' ? [n.value] : []
  if (n.type === 'TemplateElement') return [(n.value as { raw: string }).raw]
  const result: string[] = []
  eachChild(n, c => result.push(...nodeStrings(c)))
  return result
}

function elementStates(node: EsNode, inherited: ContrastState[], surfaceClasses: Set<string>): ContrastState[] {
  const opening = child(node, 'openingElement')!
  const attr = (name: string) => children(opening, 'attributes').find(p => p.type === 'JSXAttribute' && child(p, 'name')?.name === name)
  const slot = nodeStrings(child(attr('data-slot') ?? opening, 'value'))[0]
  const bodySlot = ['tool-error', 'tool-command', 'hook-entry', 'hook-source', 'hook-raw-toggle', 'hook-stdout', 'hook-stderr'].includes(slot ?? '')
  const deduped = new Map<string, ContrastState>()
  for (const classes of classBranches(child(attr('className') ?? opening, 'value')).flatMap(utilityStates)) {
    const overrides = classOverrides(classes, surfaceClasses)
    for (const parent of inherited) {
      const next = applyOverrides(parent, overrides, bodySlot)
      const key = stateKey(next)
      if (!deduped.has(key)) deduped.set(key, next)
    }
  }
  return [...deduped.values()]
}

/** Each JSX element reads the state of its nearest JSX ancestor; expression wrappers preserve it. */
export function contrastVisitors(surfaceClasses: Set<string>, report: (node: EsNode) => void): Visitors {
  const states = new WeakMap<EsNode, ContrastState[]>()
  return {
    JSXElement(node) {
      let ancestor = node.parent
      while (ancestor && ancestor.type !== 'JSXElement') ancestor = ancestor.parent
      const current = elementStates(node, ancestor ? states.get(ancestor) ?? [initialState] : [initialState], surfaceClasses)
      states.set(node, current)
      if (children(node, 'children').some(rendersText) && current.some(state => state.onCard && !state.large && state.unsafeInk)) report(child(node, 'openingElement')!)
    },
  }
}

/** The runner's baseline reader shares the visitor analysis and parses only its explicit inputs. */
export function scan(source: string, surfaceClasses: Set<string>): string[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx', 'estree'] }).program as unknown as EsNode
  const found: string[] = []
  const visitors = contrastVisitors(surfaceClasses, node => found.push(source.slice(Number(node.start), Number(node.end)).replace(/\s+/g, ' ')))
  function walk(node: EsNode, parent?: EsNode): void {
    const withParent = Object.assign(node, { parent })
    visitors[node.type]?.(withParent)
    eachChild(node, nested => walk(nested, node))
  }
  walk(ast)
  return found
}

/** Consume duplicate entries individually, as the original sorted-array equality did. */
export function compareContrast(actual: string[], baseline: string[]) {
  const remaining = [...baseline]
  const added = actual.filter(site => {
    const index = remaining.indexOf(site)
    if (index < 0) return true
    remaining.splice(index, 1)
    return false
  })
  return { added, stale: remaining }
}

export const scannedContrastFile = (file: string): boolean =>
  file.startsWith(WEB_SRC) && file.endsWith('.tsx') && !file.slice(file.lastIndexOf('/') + 1).includes('.test.')

let baseline: string[] | undefined
export const card2Contrast: AstRule = {
  name: 'card-2-contrast',
  description: 'Guard small-text contrast on card-2 (hearsay-tools/cezarion#1133, hearsay-tools/cezarion#2423).',
  applies: scannedContrastFile,
  create(report, context) {
    const local = context.file.slice(WEB_SRC.length)
    const remaining = [...(baseline ??= readContrastBaseline())]
    return contrastVisitors(paletteSurfaces(), node => {
      const site = `${local}: ${context.sourceCode.getText(node).replace(/\s+/g, ' ')}`
      const index = remaining.indexOf(site)
      if (index >= 0) { remaining.splice(index, 1); return }
      report(node, `Unsafe small text: ${site}. Use text-muted-foreground for soft ink, text-signal-word-red for danger ink or text-signal-word-amber for amber ink. Fix new sites; remove fixed entries from the baseline. Never add allowances. (hearsay-tools/cezarion#1133, hearsay-tools/cezarion#2423).`)
    })
  },
}
