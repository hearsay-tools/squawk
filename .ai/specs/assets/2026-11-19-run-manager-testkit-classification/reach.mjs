// Lists the non-browser test files that reach workflows/run.ts, and how: a direct import, a testkit, or a
// production module first on the shortest import path. Marks the users of the three testkits that
// hearsay-tools/squawk#3937 covers. Usage: node reach.mjs <audit-dir> <repo>; writes <audit-dir>/reach.json.
import { writeFileSync } from 'node:fs'
import { load, adjacency, groupOf } from './model.mjs'

const [dir, repo] = process.argv.slice(2)
const m = load(dir, repo)
const adj = adjacency(m.g)
const hub = 'packages/cezar/src/workflows/run.ts'
const outOfScope = ['server/run-manager.testkit.ts', 'delegation/service.testkit.ts', 'task-cli/cockpit.testkit.ts'].map((f) => `packages/cezar/src/${f}`)
const isKit = (f) => /testkit|fixture.*\.ts$|test-.*\.ts$/.test(f) && !/\.test\.tsx?$/.test(f)

function shortestPath(start) {
  const prev = new Map([[start, null]])
  const queue = [start]
  while (queue.length) {
    const f = queue.shift()
    for (const n of adj.get(f) ?? []) {
      if (prev.has(n)) continue
      prev.set(n, f)
      if (n === hub) {
        const path = []
        for (let x = hub; x; x = prev.get(x)) path.unshift(x)
        return path
      }
      queue.push(n)
    }
  }
  return null
}

const rows = []
for (const t of m.sq.tests) {
  if (!t.hasWalk || groupOf(t) === 'browser') continue
  const path = shortestPath(t.path)
  if (!path) continue
  const how = path.length === 2 ? 'direct' : isKit(path[1]) ? 'testkit' : 'production'
  const kits = (adj.get(t.path) ?? []).filter(isKit)
  const issue3937 = how === 'testkit' && (path.some((f) => outOfScope.includes(f)) || kits.some((f) => outOfScope.includes(f)))
  rows.push({ test: t.path, group: groupOf(t), how, kit: how === 'testkit' ? path[1] : null, path, issue3937 })
}
writeFileSync(`${dir}/reach.json`, JSON.stringify(rows, null, 1))
const count = (pred) => rows.filter(pred).length
console.log({ reachRunTs: rows.length, direct: count((r) => r.how === 'direct'), production: count((r) => r.how === 'production'),
  testkit: count((r) => r.how === 'testkit'), testkitIssue3937: count((r) => r.issue3937), toClassify: count((r) => r.how === 'testkit' && !r.issue3937) })
