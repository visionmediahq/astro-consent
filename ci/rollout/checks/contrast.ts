// Contrast (spec C3 step 6), ported from the pilot kit's contrast.ts. The page rasterises each
// computed colour through a canvas, because Chromium can serialise them as oklch(), oklab(… / a) or
// color(srgb …); the ratio is computed here with lib/colour.ts.
//
// Effective background: from the element up, every background colour until the first opaque one,
// composited outside-in. Text with alpha is composited over that. A background image on the way, or
// no opaque background at all (composited over the white canvas then), makes the row indeterminate:
// the ratio is still given, but it is not proof: such a row's `ok` is always false. DaisyUI's noise texture on buttons (an inline SVG
// feTurbulence at 20 % opacity) is decoration on top of the button colour and does not count.
//
// Gradients of colours are not images in that sense (nanolfs-villan's footer is a linear-gradient of
// two brand blues). Their stops are read from the computed value (var() already resolved), rasterised
// by the page like every other colour, and every point between consecutive stops is sampled, alpha
// composited over what is beneath: the row is measured against the worst point. A url(), a stop
// that does not rasterise, or anything else the parser is unsure of stays indeterminate.
import type { Browser, Page } from '@playwright/test'
import { type Rgb, wcagContrast } from '../lib/colour'
import { freshPage, gotoPage } from './requests'

type Rgba = [number, number, number, number] // 0..255, alpha too

/** 'banner': a banner button. 'links': PrivacyLinks text. 'placeholder': an unloaded embed's info text, Visa button, remember label or open link (#46). */
export type ContrastKind = 'banner' | 'links' | 'placeholder'

export interface RawContrast {
  kind: ContrastKind
  label: string
  /** Text colour as the canvas returns it. */
  fg: Rgba
  /** Background colours from the element outwards, up to and including the first opaque one. */
  layers: Rgba[]
  /** Computed background-image values (other than 'none') on the way to the first opaque background. */
  images: BgImage[]
  /** Each gradient stop's colour string as the page's canvas rasterised it; null when it is not a colour. Filled by measureContrast. */
  colours?: Record<string, Rgba | null>
}

export interface BgImage {
  /** Computed background-image (one or more comma-separated layers, the first on top). */
  value: string
  /** Index into `layers` this image lies directly above: layers[at] is beneath it, layers[at - 1] on top. */
  at: number
  /** Computed background-size, -repeat and -position (comma lists, one per layer). */
  size: string
  repeat: string
  position: string
}

export interface ContrastRow {
  path?: string
  kind: ContrastKind
  /** The button's or link's text. */
  button: string
  ratio: number
  /** ratio ≥ 4.5 and not indeterminate. An indeterminate row is never a pass, whatever its ratio. */
  ok: boolean
  fg: Rgb
  bg: Rgb
  indeterminate?: string
  /** How the ratio was found when it is not a plain colour, e.g. 'gradient, worst stop'. */
  note?: string
}

/** The evidence line verify and live print for a row. */
export const formatContrast = (r: ContrastRow): string =>
  `${r.path ?? ''} ${r.kind} "${r.button}" ${r.ratio.toFixed(2)}:1 ${r.ok ? 'ok' : 'FAIL'}${r.note ? ` (${r.note})` : ''}${r.indeterminate ? ` (indeterminate: ${r.indeterminate})` : ''}`

// Passed as a string: tsx adds __name helpers to functions, which don't exist in the page.
const MEASURE = `(() => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0, 0, 0, 0)'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
  const layersOf = (el) => {
    const layers = []
    const images = []
    for (let e = el; e; e = e.parentElement) {
      const style = getComputedStyle(e)
      if (style.backgroundImage && style.backgroundImage !== 'none') images.push({ value: style.backgroundImage, at: layers.length, size: style.backgroundSize, repeat: style.backgroundRepeat, position: style.backgroundPosition })
      const c = rgba(style.backgroundColor)
      if (c[3] === 0) continue
      layers.push(c)
      if (c[3] === 255) break
    }
    return { layers, images }
  }
  const visible = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0
  const row = (kind, e) => ({ kind, label: (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40), fg: rgba(getComputedStyle(e).color), ...layersOf(e) })
  return [
    ...[...document.querySelectorAll('[data-consent-banner] button')].filter(visible).map((e) => row('banner', e)),
    ...[...document.querySelectorAll('[data-privacy-links] button, [data-privacy-links] a')].filter(visible).map((e) => row('links', e)),
    // A dark theme that sets base-content but not base-200 leaves light text on the light
    // placeholder (knutssonsbil, about 1.2:1). Only embeds that have not loaded show one.
    ...[...document.querySelectorAll(['> div:first-child', '[data-load]', 'label', 'a[data-open]'].map((s) => '[data-consent-embed]:not([data-active]) [data-placeholder] ' + s).join(', '))].filter(visible).map((e) => row('placeholder', e)),
  ]
})()`

// Rasterises colour strings the way MEASURE does; null for anything CSS does not take as a colour.
const RASTER = `((colours) => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  return colours.map((c) => {
    if (!CSS.supports('color', c)) return null
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0, 0, 0, 0)'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data]
  })
})`

const over = (top: Rgba, below: Rgb): Rgb => {
  const a = top[3] / 255
  const mix = (t: number, b: number) => Math.round(a * t + (1 - a) * b)
  return { r: mix(top[0], below.r), g: mix(top[1], below.g), b: mix(top[2], below.b) }
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }

const DAISY_NOISE = /url\("data:image\/svg\+xml[^"]*feTurbulence[^"]*"\)/g

/** A background-image that can change what is behind the text: anything but 'none' and DaisyUI's noise. */
export function coversBackground(backgroundImage: string): boolean {
  return backgroundImage.replace(DAISY_NOISE, '').replace(/none|,|\s/g, '') !== ''
}

/** Splits at commas (or whitespace) outside parentheses. */
function splitTop(s: string, sep: ',' | ' '): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && (sep === ',' ? ch === ',' : /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const COLOUR_FN = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const LEGACY = /^(?:rgba?\(|hsla?\(|#|transparent$)/i
const isColour = (t: string) => COLOUR_FN.test(t) || /^#[0-9a-f]{3,8}$/i.test(t) || /^transparent$/i.test(t)
const POSITION = /^-?(?:\d+\.?\d*|\.\d+)(?:%|[a-z]+)?$|^calc\(/i

/**
 * The colour stops of one computed gradient layer, in order, and its interpolation space when that
 * is not sRGB. Undefined for anything else (url(), image-set(), currentcolor, a var() left
 * unresolved, an argument it does not understand): the caller then stays indeterminate.
 */
export function gradientStops(layer: string): { stops: string[]; space?: string } | undefined {
  const m = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/is.exec(layer.trim())
  if (!m) return undefined
  const args = splitTop(m[1]!, ',')
  const stops: string[] = []
  let space: string | undefined
  for (const [i, arg] of args.entries()) {
    const tokens = splitTop(arg, ' ')
    if (tokens.length && isColour(tokens[0]!)) {
      if (tokens.length > 3 || !tokens.slice(1).every((t) => POSITION.test(t))) return undefined
      stops.push(tokens[0]!)
    } else if (tokens.length === 1 && POSITION.test(tokens[0]!) && stops.length) {
      // A colour hint between two stops: it moves the midpoint, not the colours.
    } else if (i === 0) {
      // Direction, shape and position, or an interpolation method ("in oklch", "in hsl longer hue").
      if (tokens.some((t) => t.includes('(') && !/^calc\(/i.test(t))) return undefined
      const k = tokens.findIndex((t) => t.toLowerCase() === 'in')
      if (k >= 0) space = tokens[k + 1]?.toLowerCase()
    } else return undefined
  }
  if (stops.length < 2) return undefined
  // Stops that are not all legacy sRGB colours interpolate in oklab by default (CSS Color 4).
  if (!space && !stops.every((c) => LEGACY.test(c))) space = 'oklab'
  if (space === 'srgb') space = undefined
  return space ? { stops, space } : { stops }
}

/** Whether an image layer covers the whole box: it repeats, or is the box's size at its origin. */
const covers = (size: string, repeat: string, position: string) =>
  /^repeat(?: repeat)?$/.test(repeat) || (/^(?:auto(?: auto)?|cover|100% 100%)$/.test(size) && /^(?:0%(?: 0%)?|0px 0px)$/.test(position))

const SAMPLES = 16
const MAX_CANDIDATES = 4096

type Point = { c: Rgba; stop: boolean }
type Entry = { kind: 'colour'; c: Rgba } | { kind: 'gradient'; points: Point[]; covers: boolean; space?: string } | { kind: 'unknown' }

/** Points along a gradient: the stops and SAMPLES steps between each pair, interpolated premultiplied in sRGB. */
function samplePoints(stops: Rgba[]): Point[] {
  const points: Point[] = [{ c: stops[0]!, stop: true }]
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!
    const b = stops[i]!
    for (let k = 1; k <= SAMPLES; k++) {
      const t = k / SAMPLES
      const alpha = a[3] + (b[3] - a[3]) * t
      const ch = (j: number) => (alpha === 0 ? 0 : (a[j]! * a[3] + (b[j]! * b[3] - a[j]! * a[3]) * t) / alpha)
      points.push({ c: [ch(0), ch(1), ch(2), alpha], stop: k === SAMPLES })
    }
  }
  return points
}

/** A row's background from the bottom up: colours and image layers in paint order. */
function entries(r: RawContrast): Entry[] {
  const imageLayers = (img: BgImage): Entry[] => {
    const sizes = splitTop(img.size, ',')
    const repeats = splitTop(img.repeat, ',')
    const positions = splitTop(img.position, ',')
    const nth = (xs: string[], i: number, d: string) => xs[i % Math.max(1, xs.length)] ?? d
    const es: Entry[] = []
    for (const [i, layer] of splitTop(img.value, ',').entries()) {
      if (!coversBackground(layer)) continue
      const g = gradientStops(layer)
      const stops = g?.stops.map((c) => r.colours?.[c] ?? null)
      if (!g || !stops || stops.some((c) => c === null)) es.push({ kind: 'unknown' })
      else
        es.push({
          kind: 'gradient',
          points: samplePoints(stops as Rgba[]),
          covers: covers(nth(sizes, i, 'auto'), nth(repeats, i, 'repeat'), nth(positions, i, '0% 0%')),
          ...(g.space ? { space: g.space } : {}),
        })
    }
    return es.reverse() // the first layer is painted on top
  }
  const out: Entry[] = []
  for (let i = r.layers.length; i >= 0; i--) {
    if (i < r.layers.length) out.push({ kind: 'colour', c: r.layers[i]! })
    // images[] runs inner to outer: at the same index, the outer element's image is painted first.
    for (const img of [...r.images].reverse()) if (img.at === i) out.push(...imageLayers(img))
  }
  return out
}

const opaqueCover = (e: Entry) =>
  e.kind === 'colour' ? e.c[3] === 255 : e.kind === 'gradient' && e.covers && e.points.every((p) => p.c[3] === 255)

type Candidate = { bg: Rgb; stop: boolean }

/** Pure: composites the page's raw colours and computes the WCAG ratio for each row. */
export function contrastRows(raw: RawContrast[]): ContrastRow[] {
  return raw.map((r) => {
    const es = entries(r)
    // Everything beneath the topmost opaque layer that covers the box is hidden.
    let start = es.length - 1
    while (start >= 0 && !opaqueCover(es[start]!)) start--
    const opaque = start >= 0
    // Every background colour the text may sit on; `stop`: not a point between two gradient stops.
    let cands: Candidate[] = [{ bg: WHITE, stop: true }]
    let image = false
    let gradient = false
    const spaces = new Set<string>()
    for (const e of es.slice(Math.max(0, start))) {
      if (e.kind === 'colour') cands = cands.map((c) => ({ ...c, bg: over(e.c, c.bg) }))
      else if (e.kind === 'unknown') image = true
      else {
        gradient = true
        if (e.space) spaces.add(e.space)
        const next = e.points.flatMap((p) => cands.map((c) => ({ bg: over(p.c, c.bg), stop: p.stop && c.stop })))
        cands = e.covers ? next : [...next, ...cands]
      }
      const seen = new Map<string, Candidate>()
      for (const c of cands) {
        const k = `${c.bg.r},${c.bg.g},${c.bg.b}`
        const had = seen.get(k)
        if (!had || (c.stop && !had.stop)) seen.set(k, c)
      }
      cands = [...seen.values()]
      if (cands.length > MAX_CANDIDATES) {
        image = true // too many stacked gradients to be sure of
        cands = cands.slice(0, MAX_CANDIDATES)
      }
    }
    let worst: (Candidate & { fg: Rgb; ratio: number }) | undefined
    for (const c of cands) {
      const fg = over(r.fg, c.bg)
      const ratio = wcagContrast(fg, c.bg)
      if (!worst || ratio < worst.ratio - 1e-9 || (Math.abs(ratio - worst.ratio) <= 1e-9 && c.stop && !worst.stop)) worst = { ...c, fg, ratio }
    }
    const { bg, fg, ratio, stop } = worst!
    const indeterminate = image
      ? 'background image behind the text'
      : !opaque
        ? 'no opaque background; composited over white'
        : undefined
    const note = gradient
      ? `gradient, ${stop ? 'worst stop' : 'worst point between stops'}${spaces.size ? `; interpolated in ${[...spaces].join('/')}, sampled in sRGB` : ''}`
      : undefined
    return { kind: r.kind, button: r.label, ratio, ok: ratio >= 4.5 && !indeterminate, fg, bg, ...(indeterminate ? { indeterminate } : {}), ...(note ? { note } : {}) }
  })
}

/** Banner buttons, PrivacyLinks text and unloaded embed placeholders on the page as it is now. */
export async function measureContrast(page: Pick<Page, 'evaluate'>): Promise<ContrastRow[]> {
  const raw = (await page.evaluate(MEASURE)) as RawContrast[]
  const wanted = [...new Set(raw.flatMap((r) => r.images.flatMap((img) => splitTop(img.value, ',').flatMap((l) => gradientStops(l)?.stops ?? []))))]
  if (wanted.length) {
    const got = (await page.evaluate(`${RASTER}(${JSON.stringify(wanted)})`)) as (Rgba | null)[]
    const colours = Object.fromEntries(wanted.map((c, i) => [c, got[i] ?? null]))
    for (const r of raw) r.colours = colours
  }
  return contrastRows(raw)
}

/**
 * Opens each path (default '/') in a fresh context and measures the visible banner buttons, the
 * PrivacyLinks text and any embed placeholder against their effective backgrounds. Step 6 wants
 * every ratio ≥ 4.5.
 */
export async function checkContrast(
  browser: Browser,
  base: string,
  paths: string[] = ['/'],
  opts: { stub?: boolean } = {},
): Promise<ContrastRow[]> {
  const rows: ContrastRow[] = []
  for (const path of paths) {
    const { context, page } = await freshPage(browser, opts.stub ?? true)
    try {
      await gotoPage(page, base + path)
      // DaisyUI buttons animate colour changes; read the settled value.
      await page.addStyleTag({ content: '* { transition: none !important }' })
      await page.waitForTimeout(300)
      for (const row of await measureContrast(page)) rows.push({ path, ...row })
    } finally {
      await context.close()
    }
  }
  return rows
}
