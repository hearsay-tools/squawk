import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { takeCoverage } from 'node:v8'
import { expect, test, vi } from 'vitest'
import { flushCoverage } from '../../e2e/spec-map/node-coverage.mjs'

vi.mock('node:v8', () => ({ takeCoverage: vi.fn() }))

test('preserves coverage when later flushes reuse the same native filename', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cez-map-flush-'))
  const native = join(directory, `coverage-${process.pid}-1794700000123-0.json`)
  const other = `coverage-${process.pid + 1}-1794700000123-0.json`
  const first = { result: [{ url: 'mock-case.mjs', functions: [{ functionName: 'scenario' }] }] }
  try {
    writeFileSync(join(directory, other), '{}')
    vi.mocked(takeCoverage).mockImplementationOnce(() => writeFileSync(native, JSON.stringify(first)))
    flushCoverage(directory)
    vi.mocked(takeCoverage).mockImplementationOnce(() => writeFileSync(native, '{"result":[]}'))
    flushCoverage(directory)
    // Node's final exit/signal dump is outside the explicit flush hook.
    writeFileSync(native, '{"result":[]}')
    const names = readdirSync(directory)
    expect(names).toContain(other)
    expect(names).toHaveLength(4)
    expect(names.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8'))))
      .toContainEqual(first)
  } finally {
    vi.mocked(takeCoverage).mockReset()
    rmSync(directory, { recursive: true, force: true })
  }
})
