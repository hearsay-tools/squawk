import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eachMapping, originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'

export interface FunctionEvidence {
  source: string
  start: number
  end: number
  executed: boolean
}
interface CoverageFunction {
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>
}
interface CoverageScript { url: string; functions: CoverageFunction[] }

function lineStarts(code: string): number[] {
  return [0, ...Array.from(code.matchAll(/\n/g), (match) => match.index + 1)]
}

function lineAt(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle]! <= offset) low = middle + 1
    else high = middle
  }
  return low
}

/** Translate generated server lines through the source map emitted by the harness build. */
function position(file: string, starts: number[], offset: number, root: string, map: TraceMap | null) {
  const line = lineAt(starts, offset)
  if (!map) return { source: relative(root, file), line }
  const column = offset - (starts[line - 1] ?? 0)
  const original = originalPositionFor(map, { line, column })
  return repositoryPosition(file, root, original.source, original.line)
}

function repositoryPosition(file: string, root: string, originalSource: string | null, line: number | null) {
  if (!originalSource || !line) return null
  const source = relative(root, resolve(dirname(file), originalSource))
  if (!source.startsWith('packages/') || source.includes('/node_modules/')) return null
  return { source, line }
}

function mappingPositions(map: TraceMap | null, starts: number[], file: string, root: string) {
  const positions: Array<{ offset: number; position: ReturnType<typeof repositoryPosition> }> = []
  if (map) eachMapping(map, (mapping) => {
    positions.push({ offset: (starts[mapping.generatedLine - 1] ?? 0) + mapping.generatedColumn,
      position: repositoryPosition(file, root, mapping.source, mapping.originalLine) })
  })
  return positions
}

/** Function ranges use original-source line numbers at the map commit. */
export function scriptFunctions(script: CoverageScript, root: string): FunctionEvidence[] {
  if (!script.url.startsWith('file:')) return []
  const file = fileURLToPath(script.url)
  const mock = /\/packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
  const server = file.startsWith(join(root, '.ai/qa/build/cezar/dist/')) && existsSync(`${file}.map`)
  if ((!mock && !server) || !existsSync(file)) return []
  const map = server ? new TraceMap(readFileSync(`${file}.map`, 'utf8'), `${file}.map`) : null
  const starts = lineStarts(readFileSync(file, 'utf8'))
  const points = mappingPositions(map, starts, file, root)
  const offsets = points.map(point => point.offset)
  const result: FunctionEvidence[] = []
  for (const fn of script.functions) {
    const range = fn.ranges[0]
    if (!range) continue
    const start = position(file, starts, range.startOffset, root, map)
    const end = position(file, starts, Math.max(range.startOffset, range.endOffset - 1), root, map)
    const positions = [start, end, ...points.slice(lineAt(offsets, range.startOffset - 1),
      lineAt(offsets, range.endOffset - 1)).map(point => point.position)]
    const spans = new Map<string, { start: number; end: number }>()
    for (const point of positions) {
      if (!point) continue
      const span = spans.get(point.source)
      spans.set(point.source, { start: Math.min(span?.start ?? point.line, point.line),
        end: Math.max(span?.end ?? point.line, point.line) })
    }
    for (const [source, span] of spans) result.push({ source, ...span, executed: range.count > 0 })
  }
  return result
}

function coverageFunctions(files: string[], root: string): FunctionEvidence[] {
  const result: FunctionEvidence[] = []
  for (const file of files) {
    const report = JSON.parse(readFileSync(file, 'utf8')) as { result?: CoverageScript[] }
    for (const script of report.result ?? []) result.push(...scriptFunctions(script, root))
  }
  return result
}

/**
 * One spec's own evidence: the shared server's snapshots while the spec ran and the coverage of the
 * mock processes it started. The shared server's startup is not in it: see `startupEvidence`.
 */
export function nodeEvidence(logs: string, spec: string, root: string): FunctionEvidence[] {
  const dir = join(logs, basename(spec, '.e2e.ts'), 'node')
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.json')).map((name) => join(dir, name)) : []
  return coverageFunctions(files, root)
}

/** The functions the shared server ran while it booted, before any spec began. */
export function startupEvidence(logs: string, root: string): FunctionEvidence[] {
  const files = existsSync(logs) ? readdirSync(logs)
    .filter((name) => /^shared-startup-\d+\.json$/.test(name)).map((name) => join(logs, name)) : []
  return coverageFunctions(files, root).filter((fn) => fn.executed)
}

/** A missing process report leaves its owner's evidence incomplete, including abrupt SIGKILL. */
export function nodeCaptureComplete(logs: string, spec: string): boolean {
  if (!existsSync(logs)) return false
  const shared = readdirSync(logs)
  if (!shared.some((name) => /^shared-startup-\d+\.json$/.test(name))) return false
  if (shared.some((name) => name.startsWith('ambiguous-task-') && name.endsWith('.json'))) return false
  const dir = join(logs, basename(spec, '.e2e.ts'), 'node')
  if (!existsSync(dir)) return false
  const names = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  if (!names.some((name) => /^server-.*\.json$/.test(name))) return false
  if (!names.filter((name) => /^expected-server-\d+\.json$/.test(name)).every((name) => {
    const pid = name.slice('expected-server-'.length, -'.json'.length)
    return names.some((candidate) => candidate.startsWith(`server-${pid}-`) && candidate.endsWith('.json'))
  })) return false
  return names.filter((name) => name.endsWith('/expected.json')).every((name) => {
    const directory = dirname(name)
    return names.some((candidate) => dirname(candidate) === directory && basename(candidate).startsWith('coverage-'))
  })
}

const CODE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/

function scriptPath(url: string): string | null {
  const bare = url.replace(/[?#].*$/, '')
  if (bare.startsWith('file:')) return fileURLToPath(bare)
  return bare.startsWith('/') ? bare : null
}

// inline-contract.mjs bundles the contract into the server's dist without a source map.
const CONTRACT_BUNDLE = /\/dist\/contract\/index\.js$/
const CONTRACT_SOURCES = 'packages/contract/src'

// The served test project (.ai/qa/served/<checkout>) and its task worktrees hold copies of the
// repository's files.
const COPY = /^\.ai\/qa\/served\/[^/]+\/(?:\.ai\/(?:cezar|squawk)\/worktrees\/[^/]+\/)?(.+)$/

function codeFilesUnder(root: string, dir: string): string[] {
  return existsSync(join(root, dir)) ? readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map((name) => `${dir}/${name.split('\\').join('/')}`).filter((path) => CODE_FILE.test(path)) : []
}

/**
 * The repository code files one loaded script stands for: its source-map sources, every contract
 * source for the contract bundle, or itself. Null for a generated file without a source map, whose
 * sources no one can name.
 */
function repositoryFiles(file: string, root: string, cache: Map<string, string[] | null>): string[] | null {
  if (cache.has(file)) return cache.get(file)!
  const path = relative(root, file)
  let files: string[] | null
  if (existsSync(`${file}.map`)) {
    const map = JSON.parse(readFileSync(`${file}.map`, 'utf8')) as { sources?: string[]; sourceRoot?: string }
    files = (map.sources ?? []).map((source) => relative(root, resolve(dirname(file), map.sourceRoot ?? '', source)))
  } else if (CONTRACT_BUNDLE.test(file)) files = codeFilesUnder(root, CONTRACT_SOURCES)
  else if (COPY.test(path) && !path.split('/').includes('dist')) files = [COPY.exec(path)![1]!]
  else if (path.startsWith('.ai/qa/') || path.split('/').includes('dist')) files = null
  else files = [path]
  files = files?.filter((path) => !path.startsWith('..') && !path.split('/').includes('node_modules') && CODE_FILE.test(path)) ?? null
  cache.set(file, files)
  return files
}

/**
 * Every repository code file a process the suite started loaded: the shared server's snapshots,
 * the mocks' coverage and the coverage every other process wrote into the loaded directory.
 * `unattributed` lists the generated files without a source map that a process loaded: while it
 * is not empty, `files` may miss their sources.
 */
export function nodeLoaded(logs: string, root: string): { files: string[]; unattributed: string[] } {
  const files = new Set<string>()
  const unattributed = new Set<string>()
  const cache = new Map<string, string[] | null>()
  const names = existsSync(logs) ? readdirSync(logs, { recursive: true, encoding: 'utf8' }) : []
  const urls = (name: string): string[] => name.endsWith('.txt')
    ? readFileSync(join(logs, name), 'utf8').split('\n').filter(Boolean)
    : ((JSON.parse(readFileSync(join(logs, name), 'utf8')) as { result?: Array<{ url: string }> }).result ?? []).map(({ url }) => url)
  for (const name of names.filter((name) => /^(?:(?:coverage-.*|server-.*|shared-startup-\d+)\.json|loads-\d+-\d+\.txt)$/.test(basename(name)))) {
    for (const url of urls(name)) {
      const file = scriptPath(url)
      const path = file ? relative(root, file) : '..'
      if (!file || path.startsWith('..') || path.split('/').includes('node_modules') || !existsSync(file)) continue
      const sources = repositoryFiles(file, root, cache)
      if (sources) for (const source of sources) files.add(source)
      else unattributed.add(path)
    }
  }
  return { files: [...files].sort(), unattributed: [...unattributed].sort() }
}

/**
 * The processes that left neither coverage nor a load log in the loaded directory, by their
 * `started-<pid>.json`; null when the capture had no loaded directory at all. Either one means the
 * loaded list misses what those processes loaded.
 */
export function unflushedProcesses(logs: string): string[] | null {
  const dir = join(logs, 'loaded')
  if (!existsSync(join(dir, 'capture.json'))) return null
  const names = readdirSync(dir)
  return names.filter((name) => /^started-\d+\.json$/.test(name)).filter((name) => {
    const pid = name.slice('started-'.length, -'.json'.length)
    return !names.some((candidate) => (candidate.startsWith(`coverage-${pid}-`) && candidate.endsWith('.json'))
      || candidate === `loads-${pid}-0.txt`)
  }).map((name) => {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { pid: number; argv?: string[] }
    return `${record.pid} (${(record.argv ?? []).join(' ')})`
  }).sort()
}
