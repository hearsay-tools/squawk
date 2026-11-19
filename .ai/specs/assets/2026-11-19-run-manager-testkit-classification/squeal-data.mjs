#!/usr/bin/env node
// Reads Squeal's per-test closure parts for one worktree from its store, read-only.
// Usage: node squeal-data.mjs <store.sqlite> <worktree-root> <out.json>
// Output: { tests: [{project, path, walk:[...], observed:[...], hasWalk}], declared: {...} }
import { DatabaseSync } from 'node:sqlite'
import { inflateRawSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const [storePath, wtRoot, out] = process.argv.slice(2)
const db = new DatabaseSync(storePath, { readOnly: true })
const wt = db.prepare('select id from worktrees where root = ?').get(wtRoot)
if (!wt) throw new Error('worktree not registered: ' + wtRoot)
const keys = db.prepare('select project, path, key from test_file_keys where worktree_id = ?').all(wt.id)
const walkStmt = db.prepare('select imports, environment from test_file_imports where project = ? and path = ? and key = ?')
const meta = (k) => { const r = db.prepare('select value from meta where key = ?').get(k); return r ? JSON.parse(r.value) : {} }
const observed = {}
const tests = []
for (const k of keys) {
  observed[k.project] ??= meta('observed.' + k.project)
  const w = k.key ? walkStmt.get(k.project, k.path, k.key) : undefined
  let walk = null
  let edges = null
  if (w) {
    const entries = JSON.parse(inflateRawSync(w.imports).toString('utf8'))
    const set = new Set()
    edges = {}
    for (const [p, s, d] of entries) { set.add(p); for (const x of s) set.add(x); for (const x of d) set.add(x); edges[p] = [s, d] }
    walk = [...set]
  }
  const fallback = db.prepare('select closure_paths from test_files where project = ? and path = ?').get(k.project, k.path)
  tests.push({ project: k.project, path: k.path, hasWalk: !!w, walk, edges,
    storedClosure: fallback ? JSON.parse(fallback.closure_paths) : null,
    observed: observed[k.project][k.path] ?? [] })
}
writeFileSync(out, JSON.stringify({ worktreeId: wt.id, tests }))
const byProj = {}
for (const t of tests) { const b = (byProj[t.project] ??= { n: 0, walk: 0 }); b.n++; if (t.hasWalk) b.walk++ }
console.log(byProj)
