import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { oklchL, parseColour, pickText, readLCut, wcagContrast } from '../../ci/rollout/lib/colour'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const css = read('../../src/styles/contrast.css')
const L_CUT = readLCut(css)
const primaries: { name: string; primary: string }[] = JSON.parse(read('./fixtures/primaries.json'))

// Primaries where the rule keeps AA but picks the colour with the lower contrast. Filled only
// after tuning, one comment per entry with both contrasts.
const KNOWN_EXCEPTIONS: string[] = []

const BLACK = parseColour('#000')
const WHITE = parseColour('#fff')
const rgbOf = (pick: 'black' | 'white') => (pick === 'black' ? BLACK : WHITE)
const better = (p: ReturnType<typeof parseColour>) =>
  wcagContrast(BLACK, p) >= wcagContrast(WHITE, p) ? 'black' : 'white'

describe('colour maths', () => {
  test('contrast and lightness anchors', () => {
    expect(wcagContrast(BLACK, WHITE)).toBeCloseTo(21, 5)
    expect(wcagContrast(parseColour('#ff0000'), BLACK)).toBeCloseTo(5.25, 1)
    expect(oklchL(WHITE)).toBeCloseTo(1, 3)
  })

  test('parses #rgb, rgb() and oklch()', () => {
    expect(parseColour('#f00')).toEqual({ r: 255, g: 0, b: 0 })
    expect(parseColour('rgb(0, 128, 255)')).toEqual({ r: 0, g: 128, b: 255 })
    const white = parseColour('oklch(100% 0 0)')
    expect(white.r).toBeGreaterThan(254.5)
    expect(white.g).toBeGreaterThan(254.5)
    expect(white.b).toBeGreaterThan(254.5)
  })

  test('readLCut ignores the @supports probe', () => {
    expect(readLCut('@supports (color: oklch(from red (0.6 - l) * 1000000 0 0)) { a { --f: (0.42 - l) * 1000000 } }')).toBe(0.42)
  })
})

describe('pickText', () => {
  test('red takes black', () => {
    expect(pickText(parseColour('#ff0000'), L_CUT)).toBe('black')
  })

  test('domeij orange takes black at about 6.2', () => {
    const p = parseColour('#eb5e28')
    expect(wcagContrast(rgbOf(pickText(p, L_CUT)), p)).toBeCloseTo(6.2, 1)
  })

  for (const { name, primary } of primaries) {
    const p = parseColour(primary)
    test(`${name} meets AA`, () => {
      expect(wcagContrast(rgbOf(pickText(p, L_CUT)), p)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${name} picks the better colour`, () => {
      if (KNOWN_EXCEPTIONS.includes(name)) return
      expect(pickText(p, L_CUT)).toBe(better(p))
    })
  }
})

describe('contrast.css', () => {
  test('rule is scoped to the banner and embeds', () => {
    expect(css).toContain('[data-consent-banner] .btn-primary')
    expect(css).toContain('[data-consent-embed] .btn-primary')
  })

  test('rule is guarded by @supports', () => {
    const guard = '@supports (color: oklch(from red clamp(0, (0.6 - l) * 1000000, 1) 0 0))'
    const at = css.indexOf(guard)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(css.indexOf('.btn-primary')).toBeGreaterThan(at)
  })

  test('uses the 1000000 factor', () => {
    expect(css).toContain('* 1000000')
    expect(css).not.toMatch(/\* 1000\b(?!0)/)
  })

  test('both components import it', () => {
    for (const f of ['ConsentBanner', 'ConsentEmbed']) {
      const front = read(`../../src/components/${f}.astro`).split('---')[1] ?? ''
      expect(front).toContain("import '../styles/contrast.css'")
    }
  })
})
