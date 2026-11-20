import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { flushProcesses, pending } from '../../e2e/spec-map/flush-processes.ts'

// .ai/specs/2026-11-20-e2e-selection-evidence-plan.md, slice 3: every process the suite starts
// writes its coverage into the loaded directory (flush-processes.ts stops the ones still running).
const preload = resolve(import.meta.dirname, '../../e2e/spec-map/node-preload.mjs')
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cez-map-loaded-'))
  directories.push(directory)
  // The caller's TMPDIR may sit below a package with type=module.
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  return directory
}

function start(script: string, env: Record<string, string>) {
  const { NODE_V8_COVERAGE: _external, ...base } = process.env
  const child = spawn(process.execPath, [script], { env: { ...base, NODE_OPTIONS: `--import=${preload}`, ...env } })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  const said = async (text: string) => { while (!output.includes(text)) await once(child.stdout, 'data') }
  return { child, said, output: () => output }
}

test('a process writing into a marked loaded directory records itself and writes its coverage on SIGTERM', async () => {
  const directory = temp()
  const loaded = join(directory, 'loaded')
  mkdirSync(loaded)
  writeFileSync(join(loaded, 'capture.json'), '{}')
  const script = join(directory, 'worker.js')
  writeFileSync(script, "function work() { return 1 }; work(); console.log('ready'); process.stdin.resume();")
  const { child, said } = start(script, { NODE_V8_COVERAGE: loaded })
  await said('ready')
  expect(JSON.parse(readFileSync(join(loaded, `started-${child.pid}.json`), 'utf8'))).toEqual({ pid: child.pid, argv: ['worker.js'] })
  expect(pending(loaded)).toEqual([child.pid])
  const exited = once(child, 'exit')
  // bound: a short deadline; the child writes its coverage as soon as SIGTERM arrives.
  expect(await flushProcesses(loaded, { timeoutMs: 10_000, intervalMs: 20 })).toEqual({ signalled: 1, unflushed: [] })
  expect((await exited)[1]).toBe('SIGTERM')
  expect(readdirSync(loaded).some(name => name.startsWith(`coverage-${child.pid}-`))).toBe(true)
})

test('a process killed with SIGKILL leaves the modules it loaded, its worker threads\' too', async () => {
  // Measured in the spec-map run: skill and model-catalog probes end their mock with SIGKILL.
  const directory = temp()
  const loaded = join(directory, 'loaded')
  mkdirSync(loaded)
  writeFileSync(join(loaded, 'capture.json'), '{}')
  writeFileSync(join(directory, 'dep.js'), 'exports.x = 1')
  writeFileSync(join(directory, 'inner.js'), "require('./dep.js')")
  const script = join(directory, 'killed.js')
  const evaluated = join(directory, 'evaluated.mjs')
  writeFileSync(script, `require('./dep.js');
    // Evaluated outside Node's loader, as Vitest's module runner does.
    require('node:vm').runInThisContext('1', { filename: ${JSON.stringify(evaluated)} });
    new (require('node:vm').Script)('2', ${JSON.stringify(pathToFileURL(evaluated).href)});
    const { Worker } = require('node:worker_threads');
    new Worker(${JSON.stringify(join(directory, 'inner.js'))}, { execArgv: [] }).on('exit', () => console.log('ready'));
    process.stdin.resume();`)
  const { child, said } = start(script, { NODE_V8_COVERAGE: loaded })
  await said('ready')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  const log = (thread: number) => readFileSync(join(loaded, `loads-${child.pid}-${thread}.txt`), 'utf8').split('\n').filter(Boolean)
  expect(log(0)).toEqual(expect.arrayContaining([pathToFileURL(script).href, pathToFileURL(join(directory, 'dep.js')).href,
    evaluated, pathToFileURL(evaluated).href]))
  expect(log(1)).toEqual(expect.arrayContaining([pathToFileURL(join(directory, 'inner.js')).href, pathToFileURL(join(directory, 'dep.js')).href]))
})

test('a process whose coverage directory has no marker records nothing', async () => {
  const directory = temp()
  const coverage = join(directory, 'coverage')
  mkdirSync(coverage)
  const script = join(directory, 'plain.js')
  writeFileSync(script, "console.log('ready')")
  const { child } = start(script, { NODE_V8_COVERAGE: coverage })
  await once(child, 'exit')
  expect(readdirSync(coverage).filter(name => name.startsWith('started-') || name.startsWith('loads-'))).toEqual([])
})

test('the shared server passes the loaded directory to the processes it starts', async () => {
  const root = temp()
  mkdirSync(join(root, 'loaded'))
  writeFileSync(join(root, 'loaded', 'capture.json'), '{}')
  mkdirSync(join(root, 'dist'))
  const server = join(root, 'dist', 'index.js')
  writeFileSync(server, "console.log('coverage:' + process.env.NODE_V8_COVERAGE); process.exit(0)")
  const { child, output } = start(server, { E2E_SPEC_MAP_NODE_DIR: root })
  await once(child, 'exit')
  expect(output()).toContain(`coverage:${join(root, 'loaded')}`)
  // The server keeps its own per-spec snapshots and is not a loaded-directory process itself.
  expect(existsSync(join(root, 'loaded', `started-${child.pid}.json`))).toBe(false)
})
