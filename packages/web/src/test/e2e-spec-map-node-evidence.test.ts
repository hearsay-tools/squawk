// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { nodeCaptureComplete, nodeEvidence, nodeLoaded, scriptFunctions, startupEvidence, unflushedProcesses } from '../../e2e/spec-map/node-evidence'
import { buildMap, mapProblems } from '../../e2e/spec-map/spec-map'

it('keeps executed and unexecuted mock functions separate in the published map', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-node-evidence-'))
  try {
    const file = join(root, 'packages/cezar/scripts/mock-example.mjs')
    mkdirSync(dirname(file), { recursive: true })
    const code = 'function used() {\n return 1\n}\nfunction unused() {\n return 2\n}\nused()\n'
    writeFileSync(file, code)
    const functions = scriptFunctions({ url: pathToFileURL(file).href, functions: [
      { ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] },
      { ranges: [{ startOffset: 0, endOffset: code.indexOf('function unused'), count: 1 }] },
      { ranges: [{ startOffset: code.indexOf('function unused'), endOffset: code.indexOf('used()\n'), count: 0 }] },
    ] }, root)
    const map = buildMap({ 'packages/web/e2e/smoke.e2e.ts': {
      status: 'passed', executed: ['packages/web/src/main.tsx'], loaded: [], functions,
    } }, new Map(), 'a'.repeat(40), 'now')
    expect(map.functions?.['packages/cezar/scripts/mock-example.mjs']).toEqual([
      { start: 1, end: 7, specs: [0] }, { start: 1, end: 3, specs: [0] }, { start: 4, end: 6, specs: [] },
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
})


it('maps server function offsets back to TypeScript and refuses missing process evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-node-server-'))
  try {
    const generated = join(root, '.ai/qa/build/cezar/dist/example.js')
    mkdirSync(dirname(generated), { recursive: true })
    const source = 'packages/cezar/src/example.ts'
    writeFileSync(generated, 'function used() { return 1 }')
    writeFileSync(`${generated}.map`, JSON.stringify({ version: 3, names: [],
      sources: ['../../../../../packages/cezar/src/example.ts'], mappings: 'AAAA',
    }))
    const script = { url: pathToFileURL(generated).href,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 27, count: 1 }] }] }
    expect(scriptFunctions(script, root)).toEqual([{ source, start: 1, end: 1, executed: true }])
    const logs = join(root, 'logs')
    const spec = 'packages/web/e2e/smoke.e2e.ts'
    expect(nodeCaptureComplete(logs, spec)).toBe(false)
    const node = join(logs, 'smoke/node')
    mkdirSync(join(node, 'tasks/task/1'), { recursive: true })
    writeFileSync(join(node, 'server-1.json'), JSON.stringify({ result: [script] }))
    writeFileSync(join(node, 'tasks/task/1/expected.json'), '{}')
    expect(nodeCaptureComplete(logs, spec)).toBe(false)
    writeFileSync(join(node, 'tasks/task/1/coverage-1.json'), JSON.stringify({ result: [] }))
    expect(nodeCaptureComplete(logs, spec)).toBe(false)
    writeFileSync(join(logs, 'shared-startup-1.json'), JSON.stringify({ result: [] }))
    expect(nodeCaptureComplete(logs, spec)).toBe(true)
    writeFileSync(join(logs, 'ambiguous-task-unknown.json'), '{}')
    expect(nodeCaptureComplete(logs, spec)).toBe(false)
    expect(nodeEvidence(logs, spec, root)).toEqual([{ source, start: 1, end: 1, executed: true }])
    expect(nodeEvidence(logs, 'packages/web/e2e/missing.e2e.ts', root)).toEqual([])
    expect(startupEvidence(logs, root)).toEqual([])
    writeFileSync(join(logs, 'shared-startup-1.json'), JSON.stringify({ result: [script] }))
    // The shared server's boot is its own evidence, never a spec's.
    expect(nodeEvidence(logs, 'packages/web/e2e/missing.e2e.ts', root)).toEqual([])
    expect(startupEvidence(logs, root)).toEqual([{ source, start: 1, end: 1, executed: true }])

  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('bounds server functions by every original position when mappings move backwards', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-node-reordered-'))
  try {
    const generated = join(root, '.ai/qa/build/cezar/dist/reordered.js')
    mkdirSync(dirname(generated), { recursive: true })
    const code = 'function used() {\n first();\n second();\n}\n'
    writeFileSync(generated, code)
    writeFileSync(`${generated}.map`, JSON.stringify({ version: 3, names: [],
      sources: ['../../../../../packages/cezar/src/reordered.ts'], mappings: 'AASA;AAeA;AAVA;AAPA',
    }))
    const functions = scriptFunctions({ url: pathToFileURL(generated).href,
      functions: [{ ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] }] }, root)
    expect(functions).toEqual([{ source: 'packages/cezar/src/reordered.ts', start: 8, end: 25, executed: true }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})


it('refuses publication when a captured server function has invalid source bounds', () => {
  const source = 'packages/cezar/src/reordered.ts'
  const map = buildMap({ 'packages/web/e2e/smoke.e2e.ts': {
    status: 'passed', executed: ['packages/web/src/main.tsx'], loaded: [],
    functions: [{ source, start: 25, end: 8, executed: true }],
  } }, new Map(), 'a'.repeat(40), 'now')
  expect(mapProblems(map, [], 0.9)).toContain(`invalid function ranges for ${source}`)
})

it('keeps the shared server boot apart from the specs that ran a function', () => {
  // .ai/specs/2026-11-20-e2e-selection-evidence-plan.md, slice 2.
  const source = 'packages/cezar/src/catalog.ts'
  const map = buildMap({
    'packages/web/e2e/a.e2e.ts': { status: 'passed', executed: ['packages/web/src/main.tsx'], loaded: [], functions: [
      { source, start: 1, end: 40, executed: false },
      { source, start: 5, end: 9, executed: true },
    ] },
    'packages/web/e2e/b.e2e.ts': { status: 'passed', executed: ['packages/web/src/main.tsx'], loaded: [], functions: [
      { source, start: 1, end: 40, executed: false },
    ] },
  }, new Map(), 'a'.repeat(40), 'now', [
    { source, start: 1, end: 40, executed: true },
    { source, start: 5, end: 9, executed: true },
    { source, start: 20, end: 22, executed: true },
  ])
  expect(map.version).toBe(2)
  expect(map.functions?.[source]).toEqual([
    { start: 1, end: 40, specs: [], startup: true },
    { start: 5, end: 9, specs: [0], startup: true },
    { start: 20, end: 22, specs: [], startup: true },
  ])
})

it('lists the repository code files any process loaded, and the processes that left no coverage', () => {
  // .ai/specs/2026-11-20-e2e-selection-evidence-plan.md, slice 3.
  const root = mkdtempSync(join(tmpdir(), 'cez-node-loaded-'))
  try {
    const put = (path: string, text = '') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
    put('.ai/qa/build/cezar/dist/a.js')
    put('.ai/qa/build/cezar/dist/a.js.map', JSON.stringify({ version: 3, sources: ['../../../../../packages/cezar/src/a.ts', '../../../../../node_modules/x/y.ts'] }))
    put('packages/web/e2e/environment.ts')
    put('scripts/readers.mjs')
    put('node_modules/vitest/index.js')
    put('packages/cezar/src/data.json')
    const logs = join(root, 'logs')
    const report = (path: string, urls: string[]) => put(path, JSON.stringify({ result: urls.map(url => ({ url, functions: [] })) }))
    report('logs/shared-startup-1.json', [pathToFileURL(join(root, '.ai/qa/build/cezar/dist/a.js')).href, 'node:fs'])
    report('logs/loaded/coverage-7-1-0.json', [`${pathToFileURL(join(root, 'packages/web/e2e/environment.ts')).href}?v=3`,
      pathToFileURL(join(root, 'node_modules/vitest/index.js')).href, pathToFileURL(join(root, 'packages/cezar/src/data.json')).href,
      pathToFileURL(join(root, 'gone.ts')).href])
    report('logs/smoke/node/tasks/t/1/coverage-9-1-0.json', [join(root, 'scripts/readers.mjs')])
    expect(nodeLoaded(logs, root)).toEqual(['packages/cezar/src/a.ts', 'packages/web/e2e/environment.ts', 'scripts/readers.mjs'])

    expect(unflushedProcesses(logs)).toBeNull()
    put('logs/loaded/capture.json', '{}')
    expect(unflushedProcesses(logs)).toEqual([])
    put('logs/loaded/started-7.json', JSON.stringify({ pid: 7, argv: ['vitest.mjs', 'run'] }))
    put('logs/loaded/started-8.json', JSON.stringify({ pid: 8, argv: ['index.js'] }))
    expect(unflushedProcesses(logs)).toEqual(['8 (index.js)'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
