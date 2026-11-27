// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Automated CI contrast and token-contract verification (hearsay-tools/squawk#4379).
 *
 * Parses `packages/web/src/styles/index.css` directly, resolves `var(--*)` aliases in both
 * `:root` (dark) and `.light`, converts OKLCH colors to linear sRGB, and enforces WCAG 2.1
 * contrast floors across every cockpit surface, semantic text role, pill fill, and light-theme
 * card elevation/border step.
 */

const CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.css')

function cssBlock(css: string, selector: string): string {
  const idx = css.indexOf(selector)
  if (idx < 0) throw new Error(`missing CSS block: ${selector}`)
  const open = css.indexOf('{', idx)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`unclosed CSS block: ${selector}`)
}

function parseTokens(block: string): Record<string, string> {
  const cleaned = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Record<string, string> = {}
  for (const match of cleaned.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) out[name] = value.trim()
  }
  return out
}

function resolveToken(name: string, theme: Record<string, string>, fallback: Record<string, string>, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`circular CSS token reference: --${name}`)
  seen.add(name)
  const raw = theme[name] ?? fallback[name]
  if (raw === undefined) throw new Error(`missing CSS token: --${name}`)
  const ref = /^var\(--([\w-]+)\)$/.exec(raw)
  return ref?.[1] ? resolveToken(ref[1], theme, fallback, seen) : raw
}

interface LinearRgb { r: number; g: number; b: number; a: number }

function parseOklch(value: string): LinearRgb {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+|none)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/.exec(value)
  if (!match) throw new Error(`expected OKLCH color, received: ${value}`)
  const L = Number(match[1])
  const C = Number(match[2])
  const h = match[3] === 'none' ? 0 : Number(match[3])
  const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1)
  const rad = (h * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return {
    r: Math.min(1, Math.max(0, +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: Math.min(1, Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: Math.min(1, Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)),
    a: alpha,
  }
}

function compositeOver(fg: LinearRgb, bg: LinearRgb): LinearRgb {
  const a = fg.a + bg.a * (1 - fg.a)
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  }
}

function luminance(rgb: LinearRgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b
}

function contrastRatio(fgValue: string, bgValue: string): number {
  const bg = parseOklch(bgValue)
  const fg = compositeOver(parseOklch(fgValue), bg)
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

const css = readFileSync(CSS_PATH, 'utf8')
const darkTokens = parseTokens(cssBlock(css, ':root {'))
const lightTokens = parseTokens(cssBlock(css, '.light {'))

const THEMES = [
  { name: 'dark', tokens: darkTokens, fallback: darkTokens },
  { name: 'light', tokens: lightTokens, fallback: darkTokens },
] as const

const SURFACES = [
  'surface-base',
  'surface-raised',
  'surface-muted',
  'sidebar-row-hover',
  'sidebar-row-selected',
] as const

const AA_TEXT_TOKENS = [
  'text-primary',
  'text-secondary',
  'text-muted',
  'foreground',
  'muted-foreground',
  'soft-foreground',
  'supporting-foreground',
  'link-foreground',
  'semantic-text-red',
  'semantic-text-amber',
  'semantic-text-violet',
  'semantic-text-green',
  'semantic-text-info',
  'semantic-text-conflict',
  'signal-word-red',
  'signal-word-amber',
  'pending-strong',
  'merged-text',
  'success',
  'info',
  'conflict',
] as const

describe('cockpit design token contrast (dark & light)', () => {
  it('enforces the closed four-role text scale with >= 4.5:1 contrast for primary, secondary, and muted on every surface', () => {
    for (const theme of THEMES) {
      const primary = resolveToken('text-primary', theme.tokens, theme.fallback)
      const secondary = resolveToken('text-secondary', theme.tokens, theme.fallback)
      const muted = resolveToken('text-muted', theme.tokens, theme.fallback)
      const disabled = resolveToken('text-disabled', theme.tokens, theme.fallback)

      expect(new Set([primary, secondary, muted, disabled]).size, `${theme.name} text roles must be distinct`).toBe(4)

      for (const surface of SURFACES) {
        const bg = resolveToken(surface, theme.tokens, theme.fallback)
        for (const role of ['text-primary', 'text-secondary', 'text-muted'] as const) {
          const fg = resolveToken(role, theme.tokens, theme.fallback)
          const ratio = contrastRatio(fg, bg)
          expect(ratio, `${theme.name} --${role} on --${surface} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5)
        }
      }

      // Disabled text stays legible (>= 2.5:1 on base & card) while remaining visually softer than muted.
      for (const surface of ['surface-base', 'surface-raised'] as const) {
        const bg = resolveToken(surface, theme.tokens, theme.fallback)
        const disabledRatio = contrastRatio(disabled, bg)
        const mutedRatio = contrastRatio(muted, bg)
        expect(disabledRatio, `${theme.name} --text-disabled on --${surface}`).toBeGreaterThanOrEqual(2.5)
        expect(disabledRatio, `${theme.name} --text-disabled softer than --text-muted on --${surface}`).toBeLessThan(mutedRatio)
      }
    }
  })

  it('guarantees >= 4.5:1 WCAG AA contrast for all small-size semantic text tokens on every surface in both themes', () => {
    for (const theme of THEMES) {
      for (const surface of SURFACES) {
        const bg = resolveToken(surface, theme.tokens, theme.fallback)
        for (const token of AA_TEXT_TOKENS) {
          const fg = resolveToken(token, theme.tokens, theme.fallback)
          const ratio = contrastRatio(fg, bg)
          expect(ratio, `${theme.name} --${token} on --${surface} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5)
        }
      }

      // Small red text token is distinct from the danger badge fill token.
      expect(
        resolveToken('semantic-text-red', theme.tokens, theme.fallback),
        `${theme.name} --semantic-text-red must be distinct from --danger fill`,
      ).not.toBe(resolveToken('danger', theme.tokens, theme.fallback))
    }
  })

  it('guarantees >= 4.5:1 contrast for button and signal-pill foreground/fill pairs', () => {
    const pairs = [
      ['action-foreground', 'action'],
      ['accent-strong-foreground', 'accent-strong'],
      ['signal-ink-amber', 'pending'],
      ['signal-ink', 'danger'],
      ['signal-ink', 'status-running'],
      ['signal-ink', 'success'],
    ] as const
    for (const theme of THEMES) {
      for (const [fgName, bgName] of pairs) {
        const ratio = contrastRatio(
          resolveToken(fgName, theme.tokens, theme.fallback),
          resolveToken(bgName, theme.tokens, theme.fallback),
        )
        expect(ratio, `${theme.name} --${fgName} on --${bgName} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('guarantees >= 3:1 non-text contrast for control borders and status dots on base and card surfaces', () => {
    const nonText = ['control-border', 'success', 'danger', 'info', 'status-running'] as const
    for (const theme of THEMES) {
      for (const surface of ['surface-base', 'surface-raised'] as const) {
        const bg = resolveToken(surface, theme.tokens, theme.fallback)
        for (const token of nonText) {
          const ratio = contrastRatio(resolveToken(token, theme.tokens, theme.fallback), bg)
          expect(ratio, `${theme.name} --${token} on --${surface} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(3.0)
        }
      }
    }
  })

  it('defines explicit light-theme surface step, card border, and elevation shadow tokens', () => {
    expect(resolveToken('shadow-card', darkTokens, darkTokens)).toBe('none')
    expect(resolveToken('shadow-card', lightTokens, darkTokens)).not.toBe('none')

    const lightBase = resolveToken('surface-base', lightTokens, darkTokens)
    const lightCard = resolveToken('surface-raised', lightTokens, darkTokens)
    const lightBorderCard = resolveToken('border-card', lightTokens, darkTokens)

    expect(contrastRatio(lightCard, lightBase), 'light card vs canvas step').toBeGreaterThanOrEqual(1.1)
    expect(contrastRatio(lightBorderCard, lightCard), 'light --border-card vs card').toBeGreaterThanOrEqual(1.5)
    expect(contrastRatio(lightBorderCard, lightBase), 'light --border-card vs canvas').toBeGreaterThanOrEqual(1.35)
  })
})
