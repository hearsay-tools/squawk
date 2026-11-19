// Selection model shared by reach.mjs and measure.mjs: closure(test) = static import walk (Squeal's rules)
// plus declared inputs (squeal.config.json), observed reads and, for node:test projects, Squeal's stored closure.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { matchesGlob } from 'node:path'

export function load(dir, repo) {
  const g = JSON.parse(readFileSync(`${dir}/graph.json`, 'utf8'))
  const sq = JSON.parse(readFileSync(`${dir}/squeal-data.json`, 'utf8'))
  const cfg = JSON.parse(readFileSync(`${repo}/squeal.config.json`, 'utf8'))
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean)
  const rules = Object.entries(cfg.inputs).map(([testGlob, globs]) => ({ testGlob, files: tracked.filter((f) => globs.some((gl) => matchesGlob(f, gl))) }))
  return { g, sq, rules, tracked }
}

// An edge Squeal follows: value import / export-from / side-effect import, import('x'), require('x').
// Not followed: import type, export type, all-`type` specifier lists, vi.mock, and (outside
// packages/web, which sets verbatimModuleSyntax) a value import whose names are used only as types.
export function follows(from, e) {
  if (e.kind !== 'static' && e.kind !== 'dynamic' && e.kind !== 'require') return false
  if (e.typeUsesOnly && !from.startsWith('packages/web/')) return false
  return true
}

// Build adjacency with an optional edge filter (for simulations) and extra edges.
export function adjacency(g, { drop = () => false, add = [] } = {}) {
  const adj = new Map()
  for (const [f, es] of Object.entries(g.graph)) {
    const out = []
    for (const e of es) if (follows(f, e) && !drop(f, e)) out.push(e.to)
    adj.set(f, out)
  }
  for (const [from, to] of add) { if (!adj.has(from)) adj.set(from, []); adj.get(from).push(to) }
  return adj
}

export function staticClosure(adj, start) {
  const seen = new Set([start]); const st = [start]
  while (st.length) { const f = st.pop(); for (const t of adj.get(f) ?? []) if (!seen.has(t)) { seen.add(t); st.push(t) } }
  return seen
}

export function extrasOf(m, t) {
  const s = new Set(t.observed)
  for (const r of m.rules) if (matchesGlob(t.path, r.testGlob)) for (const f of r.files) s.add(f)
  if (!t.hasWalk && t.storedClosure) for (const f of t.storedClosure) s.add(f)
  return s
}

// Groups Squeal runs at different times: browser (manual, slow), run-loop (between turns), edit (the rest).
export function groupOf(t) {
  if (t.project === 'e2e') return 'browser'
  if (/^packages\/cezar\/src\/.*parity.*\.test\.ts$/.test(t.path) || /^packages\/cezar\/src\/(.*\/)?worker-[^/]*\.test\.ts$/.test(t.path)) return 'run-loop'
  return 'edit'
}
