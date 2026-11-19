#!/usr/bin/env node
// Builds the import graph of a Squawk checkout.
// Usage: node graph.mjs <repo-root> <out.json>
// Each edge records its kind:
//   static   - value import / export-from / side-effect import
//   dynamic  - import('literal')
//   require  - require('literal')
//   mock     - vi.mock / vi.doMock('literal')
//   type     - import type / export type / import { type A, type B } (all specifiers type-only)
// and, for static value imports, whether every imported binding is used only in type
// positions in the importing file ("typeUsesOnly": the edge could be `import type`).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, posix } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const out = process.argv[3] ?? 'graph.json'
const require = createRequire(join(process.env.PARSER_ROOT ?? root, 'package.json'))
const { parse } = require('@babel/parser')

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const listing = () => process.env.GRAPH_FIND ? execFileSync('sh', ['-c', "find . -path ./node_modules -prune -o -type f -print | sed 's#^./##' | grep -v '/node_modules/'"], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }) : execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
const files = listing()
  .split('\n').filter((f) => CODE.test(f) && !f.endsWith('.d.ts') && !f.endsWith('.d.mts'))
const fileSet = new Set(files)
const allTracked = new Set(listing().split('\n'))

const pkgs = {
  '@open-mercato/cezar-contract': 'packages/contract/src',
  '@open-mercato/cezar-api-client': 'packages/api-client/src',
}

function tryFile(p) {
  const cands = [p]
  if (/\.(js|mjs|cjs|jsx)$/.test(p)) {
    const base = p.replace(/\.(js|mjs|cjs|jsx)$/, '')
    cands.push(base + '.ts', base + '.tsx', base + '.mts', base + '.cts')
  }
  cands.push(p + '.ts', p + '.tsx', p + '.js', p + '.mjs', p + '.cjs', p + '.json',
    p + '/index.ts', p + '/index.tsx', p + '/index.js')
  for (const c of cands) if (fileSet.has(c) || allTracked.has(c)) return c
  return null
}

function resolveSpec(from, spec) {
  if (spec.startsWith('node:') ) return null
  if (spec.startsWith('.')) return tryFile(posix.normalize(posix.join(posix.dirname(from), spec)))
  if (spec.startsWith('@/') && from.startsWith('packages/web/')) return tryFile('packages/web/src/' + spec.slice(2))
  for (const [name, dir] of Object.entries(pkgs)) {
    if (spec === name) return tryFile(dir + '/index.ts')
    if (spec.startsWith(name + '/')) return tryFile(dir + '/' + spec.slice(name.length + 1))
  }
  if (spec === '@wjarka/cezarion/app-type' && from.startsWith('packages/web/')) return 'packages/cezar/src/server/app-type.ts'
  return null // external package
}

// Collect identifier names used in value (non-type) positions.
const TYPE_NODES = new Set(['TSTypeAnnotation', 'TSTypeReference', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration',
  'TSTypeParameterInstantiation', 'TSTypeParameterDeclaration', 'TSTypeQuery', 'TSImportType', 'TSDeclareFunction',
  'TSModuleDeclaration', 'TSExpressionWithTypeArguments', 'TSClassImplements', 'TSInterfaceHeritage', 'TSIndexedAccessType',
  'TSTypeOperator', 'TSMappedType', 'TSTypeLiteral', 'TSUnionType', 'TSIntersectionType', 'TSFunctionType', 'TSTupleType',
  'TSArrayType', 'TSConditionalType', 'TSInferType', 'TSTypePredicate', 'TSLiteralType', 'TSTemplateLiteralType', 'TSDeclareMethod'])
const SKIPPED_KEYS = new Set(['loc', 'extra', 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeParameters', 'implements'])
const isNode = (v) => !!v && typeof v === 'object' && typeof v.type === 'string'
const typeOnlySubtree = (n) => TYPE_NODES.has(n.type) || n.type === 'ImportDeclaration' || n.type === 'TSQualifiedName' ||
  (n.type === 'ExportNamedDeclaration' && n.exportKind === 'type')

function childNodes(n) {
  const out = []
  for (const k in n) {
    if (SKIPPED_KEYS.has(k)) continue
    const v = n[k]
    if (Array.isArray(v)) out.push(...v.filter(isNode))
    else if (isNode(v)) out.push(v)
  }
  return out
}

function valueNames(ast) {
  const names = new Set()
  const stack = [ast.program]
  while (stack.length) {
    const n = stack.pop()
    if (!isNode(n) || typeOnlySubtree(n)) continue
    if (n.type === 'ExportSpecifier') {
      if (n.exportKind !== 'type' && n.local?.name) names.add(n.local.name)
      continue
    }
    if (n.type === 'Identifier' || n.type === 'JSXIdentifier') names.add(n.name)
    stack.push(...childNodes(n))
  }
  return names
}

const graph = {}
const unresolved = {}
let parseErrors = []
for (const f of files) {
  let src
  try { src = readFileSync(join(root, f), 'utf8') } catch { continue }
  let ast
  const ts = /\.(ts|tsx|mts|cts)$/.test(f)
  try {
    ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true,
      plugins: [ts ? ['typescript', { dts: false }] : null, (f.endsWith('.tsx') || f.endsWith('.jsx') || !ts) ? 'jsx' : null, 'importAttributes', 'decorators'].filter(Boolean) })
  } catch {
    try { ast = parse(src, { sourceType: 'module', errorRecovery: true, plugins: ts ? ['typescript'] : [] }) } catch (e2) { parseErrors.push([f, e2.message]); continue }
  }
  const used = valueNames(ast)
  const edges = []
  const add = (spec, kind, extra = {}) => {
    const to = resolveSpec(f, spec)
    if (to) edges.push({ to, kind, spec, line: extra.line, ...extra })
    else if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('@open-mercato')) (unresolved[f] ??= []).push(spec)
  }
  for (const s of ast.program.body) {
    if (s.type === 'ImportDeclaration') {
      const line = s.loc.start.line
      const specs = s.specifiers
      if (s.importKind === 'type') { add(s.source.value, 'type', { line }); continue }
      if (specs.length > 0 && specs.every((x) => x.importKind === 'type')) { add(s.source.value, 'type', { line, inline: true }); continue }
      if (specs.length === 0) { add(s.source.value, 'static', { line, sideEffect: true }); continue }
      const valueSpecs = specs.filter((x) => x.importKind !== 'type')
      const typeUsesOnly = ts && valueSpecs.every((x) => !used.has(x.local.name))
      add(s.source.value, 'static', { line, typeUsesOnly, names: valueSpecs.map((x) => x.type === 'ImportNamespaceSpecifier' ? '*' : x.type === 'ImportDefaultSpecifier' ? 'default' : (x.imported.name ?? x.imported.value)) })
    } else if (s.type === 'ExportNamedDeclaration' && s.source) {
      const line = s.loc.start.line
      if (s.exportKind === 'type' || (s.specifiers.length && s.specifiers.every((x) => x.exportKind === 'type'))) add(s.source.value, 'type', { line, reexport: true })
      else add(s.source.value, 'static', { line, reexport: true })
    } else if (s.type === 'ExportAllDeclaration') {
      const line = s.loc.start.line
      add(s.source.value, s.exportKind === 'type' ? 'type' : 'static', { line, reexport: true, star: true })
    }
  }
  // dynamic import(), require(), vi.mock()
  const stack = [ast.program]
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n.type !== 'string') continue
    if (n.type === 'ImportExpression' && n.source?.type === 'StringLiteral') add(n.source.value, 'dynamic', { line: n.loc.start.line })
    if (n.type === 'ImportExpression' && n.source?.type === 'TemplateLiteral' && n.source.expressions.length === 0) add(n.source.quasis[0].value.cooked, 'dynamic', { line: n.loc.start.line })
    if (n.type === 'CallExpression') {
      const c = n.callee
      if (c.type === 'Import' && n.arguments[0]?.type === 'StringLiteral') add(n.arguments[0].value, 'dynamic', { line: n.loc.start.line })
      if (c.type === 'Identifier' && c.name === 'require' && n.arguments[0]?.type === 'StringLiteral') add(n.arguments[0].value, 'require', { line: n.loc.start.line })
      if (c.type === 'MemberExpression' && c.object?.name === 'vi' && ['mock', 'doMock', 'importActual', 'importMock'].includes(c.property?.name) && n.arguments[0]?.type === 'StringLiteral') add(n.arguments[0].value, 'mock', { line: n.loc.start.line, fn: c.property.name })
    }
    for (const k in n) {
      if (k === 'loc') continue
      const v = n[k]
      if (Array.isArray(v)) for (const x of v) stack.push(x)
      else if (v && typeof v === 'object' && typeof v.type === 'string') stack.push(v)
    }
  }
  graph[f] = edges
}
const lines = Object.fromEntries(files.map((f) => {
  try { return [f, readFileSync(join(root, f), 'utf8').split('\n').length] } catch { return [f, 0] }
}))
writeFileSync(out, JSON.stringify({ root, files, graph, unresolved, parseErrors, lines }))
const counts = {}
for (const es of Object.values(graph)) for (const e of es) counts[e.kind] = (counts[e.kind] ?? 0) + 1
console.log({ files: files.length, counts, unresolvedFiles: Object.keys(unresolved).length, parseErrors: parseErrors.length })
