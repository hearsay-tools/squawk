import { afterEach, describe, expect, it } from 'vitest'

import {
  apiBase,
  apiPath,
  getApiBaseUrl,
  getApiScope,
  queryScope,
  resolveApiUrl,
  setApiBaseUrl,
  setApiScope,
} from './project-scope.ts'

afterEach(() => {
  setApiScope(null)
  setApiBaseUrl('')
})

describe('apiPath — unscoped', () => {
  // Callers name a route; this module owns the version. Nothing in the app should be able to
  // produce an unversioned `/api/...` request — the service no longer answers on one.
  it.each([
    ['/runs', '/api/v1/runs'],
    ['/runs/run-1/files?path=shot.png&raw=1', '/api/v1/runs/run-1/files?path=shot.png&raw=1'],
  ])('versions %s', (route, expected) => {
    expect(apiPath(route)).toBe(expected)
  })

  it('reports the unscoped state', () => {
    expect(getApiScope()).toBeNull()
    expect(apiBase()).toBe('/api/v1')
    expect(queryScope()).toBe('default')
  })
})

describe('apiPath — scoped', () => {
  it('inserts the project scope inside the version prefix', () => {
    setApiScope('cezar')
    expect(apiPath('/runs')).toBe('/api/v1/p/cezar/runs')
    expect(apiPath('/runs/run-1/files?path=x.png&raw=1')).toBe(
      '/api/v1/p/cezar/runs/run-1/files?path=x.png&raw=1',
    )
    expect(apiPath('/runs/run-1/events')).toBe('/api/v1/p/cezar/runs/run-1/events')
    expect(apiBase()).toBe('/api/v1/p/cezar')
    expect(queryScope()).toBe('cezar')
  })

  it('URL-encodes the project id', () => {
    // Registered slugs are tame, but the id rides into a URL — encode like every path segment.
    setApiScope('a b/c')
    expect(apiPath('/runs')).toBe('/api/v1/p/a%20b%2Fc/runs')
    expect(apiBase()).toBe('/api/v1/p/a%20b%2Fc')
  })

  it('leaves workspace-level routes unscoped — they are single-mount, scoping would 404', () => {
    setApiScope('cezar')
    expect(apiPath('/health')).toBe('/api/v1/health')
    expect(apiPath('/models?runner=codex')).toBe('/api/v1/models?runner=codex')
    expect(apiPath('/projects')).toBe('/api/v1/projects')
    expect(apiPath('/workspace/events')).toBe('/api/v1/workspace/events')
    expect(apiPath('/workspace/config')).toBe('/api/v1/workspace/config')
    expect(apiPath('/workspace/ui-state')).toBe('/api/v1/workspace/ui-state')
    expect(apiPath('/providers/status')).toBe('/api/v1/providers/status')
    expect(apiPath('/providers/status?refresh=1')).toBe('/api/v1/providers/status?refresh=1')
    expect(apiPath('/providers/connect')).toBe('/api/v1/providers/connect')
    // The folder picker (step 4.2): one filesystem behind the workspace, not one per project.
    expect(apiPath('/fs/browse')).toBe('/api/v1/fs/browse')
    expect(apiPath('/fs/browse?path=%2Fhome%2Fme')).toBe('/api/v1/fs/browse?path=%2Fhome%2Fme')
  })

  it('does not treat a lookalike route as workspace-level', () => {
    setApiScope('cezar')
    // `/healthcheck` is not `/health`; the exemption matches whole segments only.
    expect(apiPath('/healthcheck')).toBe('/api/v1/p/cezar/healthcheck')
  })

  it('treats the empty string as unscoped — there is no project ""', () => {
    setApiScope('')
    expect(getApiScope()).toBeNull()
    expect(apiPath('/runs')).toBe('/api/v1/runs')
  })
})

// Run transcripts keep the image URLs a server minted forever, so the cockpit renders URLs written
// before `/api/v1` and before project scopes: each is upgraded and re-scoped at render time, an
// absolute URL keeps its own origin, and anything that is not a cockpit API URL is left alone.
describe('resolveApiUrl — URLs the server minted', () => {
  const local = 'http://127.0.0.1:4321'
  it.each<[string, { scope?: string; base?: string }, string, string]>([
    ['upgrades an unversioned URL', {}, '/api/runs/r1/images/shot.png', '/api/v1/runs/r1/images/shot.png'],
    ['leaves an already-versioned URL alone', {}, '/api/v1/runs/r1/images/shot.png', '/api/v1/runs/r1/images/shot.png'],
    ['re-scopes an unscoped URL onto the active project', { scope: 'cezar' }, '/api/runs/r1/images/shot.png', '/api/v1/p/cezar/runs/r1/images/shot.png'],
    ['keeps an unversioned URL that names its own project', { scope: 'cezar' }, '/api/p/other/runs/r1/images/shot.png', '/api/v1/p/other/runs/r1/images/shot.png'],
    ['keeps a versioned URL that names its own project', { scope: 'cezar' }, '/api/v1/p/other/runs/r1/images/shot.png', '/api/v1/p/other/runs/r1/images/shot.png'],
    ['leaves a raw asset alone', { scope: 'cezar' }, '/raw/assets/icon.svg', '/raw/assets/icon.svg'],
    ['leaves a foreign link alone', { scope: 'cezar' }, 'https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/7'],
    ['leaves a data URI alone', { scope: 'cezar' }, 'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ['leaves a blob URL alone', { scope: 'cezar' }, 'blob:http://localhost:4321/abc-123', 'blob:http://localhost:4321/abc-123'],
    ['upgrades an absolute URL, keeping its origin', {}, `${local}/api/runs/r1/images/shot.png`, `${local}/api/v1/runs/r1/images/shot.png`],
    ['scopes an absolute URL onto the active project', { scope: 'cezar' }, `${local}/api/runs/r1/images/shot.png`, `${local}/api/v1/p/cezar/runs/r1/images/shot.png`],
    ['keeps an absolute URL that names its own project', { scope: 'cezar' }, `${local}/api/v1/p/other/runs/r1/images/shot.png`, `${local}/api/v1/p/other/runs/r1/images/shot.png`],
    ['never re-bases an absolute URL onto the configured base', { base: 'https://cezar.example.com' }, `${local}/api/runs/r1/images/a.png`, `${local}/api/v1/runs/r1/images/a.png`],
    ['re-bases a root-relative URL onto the configured base', { base: 'https://cezar.example.com' }, '/api/runs/r1/images/a.png', 'https://cezar.example.com/api/v1/runs/r1/images/a.png'],
    ['does not double-prefix a URL that already has the base', { base: 'https://cezar.example.com' }, 'https://cezar.example.com/api/v1/runs/r1/images/a.png', 'https://cezar.example.com/api/v1/runs/r1/images/a.png'],
    ['upgrades a URL that already carries a path-prefix base', { base: '/cezar' }, '/cezar/api/runs/r1/images/a.png', '/cezar/api/v1/runs/r1/images/a.png'],
    ['leaves a foreign absolute URL alone beside a base', { base: 'https://cezar.example.com' }, 'https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/7'],
  ])('%s', (_name, { scope, base }, url, expected) => {
    if (scope !== undefined) setApiScope(scope)
    if (base !== undefined) setApiBaseUrl(base)
    expect(resolveApiUrl(url)).toBe(expected)
  })
})

describe('setApiBaseUrl — the service on another origin', () => {
  it('prefixes every route once the base is set', () => {
    setApiBaseUrl('https://cezar.example.com')
    expect(apiPath('/runs')).toBe('https://cezar.example.com/api/v1/runs')
    expect(apiBase()).toBe('https://cezar.example.com/api/v1')
  })

  it('composes with the project scope', () => {
    setApiBaseUrl('https://cezar.example.com')
    setApiScope('cezar')
    expect(apiPath('/runs')).toBe('https://cezar.example.com/api/v1/p/cezar/runs')
    expect(apiBase()).toBe('https://cezar.example.com/api/v1/p/cezar')
  })

  it('tolerates a trailing slash — it would otherwise double against the route', () => {
    setApiBaseUrl('https://cezar.example.com/')
    expect(getApiBaseUrl()).toBe('https://cezar.example.com')
    expect(apiPath('/runs')).toBe('https://cezar.example.com/api/v1/runs')
  })

  it('works with a path prefix, for a service behind a reverse proxy', () => {
    setApiBaseUrl('/cezar')
    expect(apiPath('/runs')).toBe('/cezar/api/v1/runs')
  })
})
