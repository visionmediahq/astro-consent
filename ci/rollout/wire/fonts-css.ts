// Reading Google's css2 answer and choosing what to self-host (site-factory#220). Pure functions:
// no file system, no network.
//
// Which subsets: a browser downloads a face only when a character on the page falls in its
// unicode-range, and checks the faces of one family from the last defined to the first; Google
// lists latin last and latin-ext just before it. So latin and latin-ext are always kept, and any
// other subset is kept only when it covers a character the site shows that latin and latin-ext do
// not. That is everything the site could ever have fetched from Google. Keeping too much costs a
// file in the repo that no browser asks for; keeping too little shows a glyph in a fallback font.
import { createHash } from 'node:crypto'

export interface Face {
  /** The subset comment above the block (`latin`, `latin-ext`, `cyrillic`, `symbols`, …). */
  subset: string
  family: string
  style: string
  /** As written: `400`, or a variable range `400 700`. */
  weight: string
  /** The fonts.gstatic.com woff2 URL. */
  src: string
  /** The whole `@font-face { … }` block, verbatim. */
  block: string
  /** The unicode-range as [first, last] code points; everything when the block has none. */
  ranges: [number, number][]
}

const ALL: [number, number][] = [[0, 0x10ffff]]
const ALWAYS = new Set(['latin', 'latin-ext'])

/** `U+0000-00FF, U+0131, U+4??` as [first, last] pairs. */
export function parseUnicodeRange(value: string): [number, number][] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(s)
      if (!m) throw new Error(`unicode-range not understood: ${s}`)
      if (m[1]!.includes('?')) return [parseInt(m[1]!.replace(/\?/g, '0'), 16), parseInt(m[1]!.replace(/\?/g, 'f'), 16)] as [number, number]
      const first = parseInt(m[1]!, 16)
      return [first, m[2] ? parseInt(m[2], 16) : first] as [number, number]
    })
}

const property = (block: string, name: string): string | null => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, 'i').exec(block)?.[1]?.trim() ?? null

/**
 * Every face of a css2 response, in Google's order. Throws unless every block is a labelled
 * `@font-face` with exactly one fonts.gstatic.com woff2 source, which is what Google answers a
 * modern Chrome; an older User-Agent gets truetype, an error page has no @font-face.
 */
export function parseCss2(css: string): Face[] {
  const faces: Face[] = []
  const blocks = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)]
  if (blocks.length === 0) throw new Error('the response has no @font-face')
  for (const m of blocks) {
    const block = m[0]
    const before = css.slice(0, m.index).trimEnd()
    const label = /\/\*\s*([\w-]+)\s*\*\/$/.exec(before)?.[1]
    if (!label) throw new Error(`a @font-face without its subset comment: ${block.slice(0, 120)}`)
    const urls = [...block.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)\s*(?:format\(\s*['"]?([\w-]+)['"]?\s*\))?/g)]
    if (urls.length !== 1 || urls[0]![2] !== 'woff2') throw new Error(`a @font-face that is not a single woff2 source (${label}): ${property(block, 'src') ?? 'no src'}`)
    const src = urls[0]![1]!
    if (!/^https:\/\/fonts\.gstatic\.com\/\S+\.woff2$/.test(src)) throw new Error(`a woff2 source outside fonts.gstatic.com: ${src}`)
    const family = property(block, 'font-family')?.replace(/^['"]|['"]$/g, '')
    if (!family) throw new Error(`a @font-face without font-family (${label})`)
    const range = property(block, 'unicode-range')
    faces.push({
      subset: label,
      family,
      style: property(block, 'font-style') ?? 'normal',
      weight: property(block, 'font-weight') ?? '400',
      src,
      block,
      ranges: range ? parseUnicodeRange(range) : ALL,
    })
  }
  return faces
}

/** HTML named entities for characters outside latin that sites write by name. */
const NAMED: Record<string, number> = {
  larr: 0x2190, uarr: 0x2191, rarr: 0x2192, darr: 0x2193, harr: 0x2194, crarr: 0x21b5,
  lArr: 0x21d0, uArr: 0x21d1, rArr: 0x21d2, dArr: 0x21d3, hArr: 0x21d4,
  check: 0x2713, checkmark: 0x2713, cross: 0x2717, star: 0x2606, starf: 0x2605, phone: 0x260e,
  spades: 0x2660, clubs: 0x2663, hearts: 0x2665, diams: 0x2666, loz: 0x25ca,
  infin: 0x221e, le: 0x2264, ge: 0x2265, ne: 0x2260, asymp: 0x2248, minus: 0x2212, radic: 0x221a,
  sum: 0x2211, prod: 0x220f, part: 0x2202, nabla: 0x2207, isin: 0x2208, empty: 0x2205,
  bull: 0x2022, hellip: 0x2026, trade: 0x2122, euro: 0x20ac, permil: 0x2030, prime: 0x2032,
}
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigmaf', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega']
GREEK.forEach((name, i) => {
  NAMED[name] = 0x3b1 + i
  if (name !== 'sigmaf') NAMED[name[0]!.toUpperCase() + name.slice(1)] = 0x391 + i
})

/**
 * The code points a text may show: its characters, plus those written as HTML entities (named,
 * `&#…;`, `&#x…;`), JS escapes (`\uXXXX`, `\u{…}`) and CSS escapes (`\2192`). Over-reading (an
 * escape in a regex, a character in a comment) only keeps a file no browser asks for.
 */
export function codePointsOf(text: string): Set<number> {
  const out = new Set<number>()
  for (const c of text) out.add(c.codePointAt(0)!)
  const add = (n: number) => {
    if (Number.isInteger(n) && n >= 0 && n <= 0x10ffff) out.add(n)
  }
  for (const m of text.matchAll(/&#(\d{1,7});/g)) add(Number(m[1]))
  for (const m of text.matchAll(/&#x([0-9a-f]{1,6});/gi)) add(parseInt(m[1]!, 16))
  for (const m of text.matchAll(/&([A-Za-z]+);/g)) if (m[1]! in NAMED) add(NAMED[m[1]!]!)
  for (const m of text.matchAll(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/gi)) add(parseInt(m[1] ?? m[2]!, 16))
  for (const m of text.matchAll(/\\([0-9a-f]{1,6})/gi)) add(parseInt(m[1]!, 16))
  return out
}

const covers = (ranges: [number, number][], cp: number): boolean => ranges.some(([a, b]) => a <= cp && cp <= b)

export interface Selection {
  kept: Face[]
  /** Subsets kept beyond latin and latin-ext, with the site's code points that need them. */
  extra: { subset: string; codePoints: number[] }[]
  /** Subsets of the response not kept, sorted. */
  dropped: string[]
}

/** Which faces to self-host for a site that shows `codePoints` (see the header). Keeps Google's order. */
export function selectFaces(faces: Face[], codePoints: Set<number>): Selection {
  const base = faces.filter((f) => ALWAYS.has(f.subset)).flatMap((f) => f.ranges)
  const residual = [...codePoints].filter((cp) => !covers(base, cp)).sort((a, b) => a - b)
  const need = new Map<string, Set<number>>()
  const kept = faces.filter((f) => {
    if (ALWAYS.has(f.subset)) return true
    const hits = residual.filter((cp) => covers(f.ranges, cp))
    if (hits.length === 0) return false
    const set = need.get(f.subset) ?? new Set<number>()
    for (const cp of hits) set.add(cp)
    need.set(f.subset, set)
    return true
  })
  const extra = [...need].map(([subset, set]) => ({ subset, codePoints: [...set].sort((a, b) => a - b) })).sort((a, b) => (a.subset < b.subset ? -1 : 1))
  const keptSubsets = new Set(kept.map((f) => f.subset))
  const dropped = [...new Set(faces.map((f) => f.subset))].filter((s) => !keptSubsets.has(s)).sort()
  return { kept, extra, dropped }
}

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * `<family>-<style>-<weight>-<subset>-<sha256, 8 hex>.woff2`. `weights` are those of every face that
 * uses the file: one value as written (`400`, `400 700` → `400_700`), several (a variable font
 * asked for by static weights) as their range. The hash busts caches of the unhashed public/ files.
 */
export function fontFileName(family: string, style: string, weights: string[], subset: string, bytes: Uint8Array): string {
  const distinct = [...new Set(weights)]
  let weight: string
  if (distinct.length === 1) weight = distinct[0]!.trim().replace(/\s+/g, '_')
  else {
    const nums = distinct.flatMap((w) => w.trim().split(/\s+/).map(Number))
    weight = `${Math.min(...nums)}_${Math.max(...nums)}`
  }
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  return `${slug(family)}-${slug(style)}-${weight}-${slug(subset)}-${hash}.woff2`
}

/** `U+2192` for a code point. */
export const uPlus = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
