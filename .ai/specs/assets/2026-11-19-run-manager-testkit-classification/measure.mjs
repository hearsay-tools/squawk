#!/usr/bin/env node
// Measures the selection drop for each group of B and C rows.
// Usage: node measure.mjs <audit-dir> <repo> <rows.json> [ref=HEAD]; writes <audit-dir>/measure.json.
// rows.json holds the B and C rows; every other test file is unchanged.
// Weighted cost = sum over files of (first-parent commits on main touching the file in the window)
// x (edit and run-loop test files whose closure holds the file). Browser specs are not counted.
// Scenario per class:
//   B (module test): the test keeps its production imports and the modules the row names, and drops
//     every testkit import (upper bound: a small engine-free testkit it would keep is dropped too).
//   C (repeat): the test file is deleted.
//   A and out of scope: unchanged.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { load, adjacency, staticClosure, extrasOf, groupOf } from './model.mjs'

const [dir, repo, classFile, ref = 'HEAD'] = process.argv.slice(2)
const m = load(dir, repo)
const adj = adjacency(m.g)
const rows = JSON.parse(readFileSync(classFile, 'utf8'))
const byTest = new Map(rows.map((r) => [r.test, r]))
const hub = 'packages/cezar/src/workflows/run.ts'
const isKit = (f) => /testkit|fixture.*\.ts$|test-.*\.ts$/.test(f) && !/\.test\.tsx?$/.test(f)

function touches(since) {
  const out = execFileSync('git', ['log', '--first-parent', `--since=${since}`, '--format=@@%H', '--name-only', ref], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 })
  const t = new Map()
  for (const block of out.split('@@')) for (const f of block.split('\n').slice(1)) if (f) t.set(f, (t.get(f) ?? 0) + 1)
  return t
}
const windows = { d30: touches('30 days ago'), d90: touches('90 days ago') }

const counted = m.sq.tests.filter((t) => groupOf(t) !== 'browser')
const baseClosure = (t) => new Set([...(t.hasWalk ? staticClosure(adj, t.path) : [t.path]), ...extrasOf(m, t)])
const base = new Map(counted.map((t) => [t.path, baseClosure(t)]))

function moduleTestClosure(t, row) {
  const s = new Set([t.path, ...extrasOf(m, t)])
  const roots = [...(adj.get(t.path) ?? []).filter((f) => !isKit(f)), ...row.modules.filter((f) => !isKit(f))]
  for (const r of roots) for (const f of staticClosure(adj, r)) s.add(f)
  return s
}

function scenarioClosure(t, picked) {
  const row = byTest.get(t.path)
  if (!row || !picked(row)) return base.get(t.path)
  if (row.class === 'C') return new Set()
  if (row.class === 'B') return moduleTestClosure(t, row)
  return base.get(t.path)
}

function cost(closures) {
  const out = { d30: 0, d90: 0, hubTests: 0 }
  for (const c of closures) {
    if (c.has(hub)) out.hubTests++
    for (const f of c) {
      out.d30 += windows.d30.get(f) ?? 0
      out.d90 += windows.d90.get(f) ?? 0
    }
  }
  return out
}
const baseline = cost(base.values())
const pct = (a, b) => Math.round((1000 * a) / b) / 10
function scenario(name, picked) {
  const s = cost(counted.map((t) => scenarioClosure(t, picked)))
  return { name, files: rows.filter(picked).length, hubTests: s.hubTests,
    drop30: baseline.d30 - s.d30, pct30: pct(baseline.d30 - s.d30, baseline.d30),
    drop90: baseline.d90 - s.d90, pct90: pct(baseline.d90 - s.d90, baseline.d90) }
}

const groups = [...new Set(rows.filter((r) => r.class === 'B' || r.class === 'C').map((r) => r.group))].sort()
const scenarios = [
  ...groups.map((g) => scenario(g, (r) => r.group === g)),
  scenario('B import moves (all but B-fake)', (r) => r.class === 'B' && r.group !== 'B-fake'),
  scenario('all B', (r) => r.class === 'B'),
  scenario('all B and C', (r) => r.class === 'B' || r.class === 'C'),
]
const result = { ref: execFileSync('git', ['rev-parse', '--short', ref], { cwd: repo, encoding: 'utf8' }).trim(), baseline, scenarios }
writeFileSync(`${dir}/measure.json`, JSON.stringify(result, null, 1))
console.log(`ref ${result.ref}; baseline weighted cost: 30 d ${baseline.d30}, 90 d ${baseline.d90}; tests reaching run.ts ${baseline.hubTests}`)
console.log('group\tfiles\ttests reaching run.ts after\tdrop 30 d\t%\tdrop 90 d\t%')
for (const s of scenarios) console.log(`${s.name}\t${s.files}\t${s.hubTests}\t${s.drop30}\t${s.pct30}\t${s.drop90}\t${s.pct90}`)
