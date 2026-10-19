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
// two brand blues). Their stops are read from the computed value (var() already resolved) and
// rasterised by the page. Each segment between two stops is searched for its worst point: on a grid,
// then refined around every local minimum. sRGB segments are interpolated here (premultiplied, as
// browsers paint them); any other space or hue method is mixed by the page itself with color-mix()
// in the same method. One gradient that shows is measured; a second one, a url(), a stop or mix the
// page does not resolve, or a prelude keyword the parser does not know stays indeterminate.
//
// Effects the colours do not show are indeterminate too: background-blend-mode, a background-clip or
// -origin other than border/padding/content-box (text), opacity on an element with a background or
// above it, mix-blend-mode, filter or backdrop-filter on the text or any ancestor, and a positioned
// ::before/::after with a background on the way (it may sit over the text; its box is not checked).
// Opacity on the text or a background-less wrapper is folded into the text colour instead.
import type { Browser, Page } from '@playwright/test'
import { type Rgb, wcagContrast } from '../lib/colour'
import { freshPage, open } from './requests'

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
  /** Product of the opacity of the text and of background-less wrappers below every background: it fades the text. */
  fade?: number
  /** Effects on the way that the colours do not show (background-blend-mode, filter, …). */
  effects?: string[]
  /** An opacity animation is still running on the text or an ancestor (a scroll-in fade). */
  animating?: boolean
  /** Stop and color-mix() strings as the page rasterised them; null when it is not a colour. Filled by measureContrast. */
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
  const BOXES = ['border-box', 'padding-box', 'content-box']
  // filter: none, or only functions that change nothing (Tailwind leaves grayscale(0) and the like).
  const IDENTITY = /^(?:(?:grayscale|sepia|invert)\\(0%?\\)|(?:brightness|contrast|saturate|opacity)\\((?:1|100%)\\)|blur\\(0(?:px)?\\)|hue-rotate\\(0(?:deg)?\\))$/
  const noFilter = (f) => !f || f === 'none' || (f.replace(/[a-z-]+\\([^)]*\\)/g, '').trim() === '' && (f.match(/[a-z-]+\\([^)]*\\)/g) || []).every((x) => IDENTITY.test(x)))
  // A translation (or nothing): getBoundingClientRect is then still the box.
  const flat = (t) => t === 'none' || /^matrix\\(1, 0, 0, 1, [-\\d.e]+, [-\\d.e]+\\)$/.test(t)
  const px = (v) => (/^-?[\\d.]+(?:e-?\\d+)?px$/.test(v) ? parseFloat(v) : NaN)
  const opacityRunning = (e) => e.getAnimations().some((a) => (a.playState === 'running' || a.playState === 'pending') && a.effect && a.effect.getKeyframes().some((k) => 'opacity' in k))
  // transform, or Tailwind v4's individual translate/scale/rotate.
  const moved = (s) => s.transform !== 'none' || s.translate !== 'none' || s.scale !== 'none' || s.rotate !== 'none'
  // DaisyUI-style feTurbulence noise is decoration, as for backgrounds (coversBackground).
  const NOISE = /url\\("data:image\\/svg\\+xml[^"]*feTurbulence[^"]*"\\)/g
  const imagePainted = (v) => !!v && v.replace(NOISE, '').replace(/none|,|\\s/g, '') !== ''
  const flexParent = (a) => a.parentElement && /flex|grid/.test(getComputedStyle(a.parentElement).display)
  const contextOf = (a) => {
    const s = getComputedStyle(a)
    const explicit = s.zIndex !== 'auto' && (s.position !== 'static' || flexParent(a))
    const forms = explicit || /fixed|sticky/.test(s.position) || Number(s.opacity) < 1 || moved(s) || !noFilter(s.filter) || (s.backdropFilter && s.backdropFilter !== 'none') || s.mixBlendMode !== 'normal' || s.isolation === 'isolate' || /paint|strict|content|layout/.test(s.contain) || /transform|opacity|filter|perspective/.test(s.willChange) || s.perspective !== 'none' || s.clipPath !== 'none' || (s.mask && s.mask !== 'none')
    return forms ? { z: explicit ? parseInt(s.zIndex, 10) : undefined } : undefined
  }
  // The text paints above e's pseudo when the outermost stacking context around the text below e
  // has an explicit z-index above the pseudo's (ernstedt: a z-50 banner over a z-index 1 grain).
  const textAbove = (el, e, p) => {
    let outer
    for (let a = el; a && a !== e; a = a.parentElement) {
      const c = contextOf(a)
      if (c) outer = c
    }
    const zp = p.zIndex === 'auto' ? 0 : parseInt(p.zIndex, 10)
    return !!outer && outer.z !== undefined && outer.z > zp
  }
  // Whether e's positioned ::before/::after paints a background over the text's box. Its box is
  // computed only when its containing block is known: e itself (positioned, not scaled or rotated,
  // not scrolled) for absolute, the viewport for fixed (no ancestor that would capture it); anything
  // else counts. 'exempt': above the opaque layer with no z-index between, where a negative z-index
  // paints below that layer's in-flow background.
  const pseudoOver = (el, e, pseudo, text, exempt) => {
    const p = getComputedStyle(e, pseudo)
    if (p.content === 'none' || p.content === 'normal' || !/absolute|fixed/.test(p.position)) return false
    if (exempt && parseInt(p.zIndex, 10) < 0) return false
    if (!(rgba(p.backgroundColor)[3] > 0 || imagePainted(p.backgroundImage))) return false
    if (textAbove(el, e, p)) return false
    if (moved(p) || p.direction === 'rtl') return true
    let x0, y0
    if (p.position === 'absolute') {
      const s = getComputedStyle(e)
      if (s.position === 'static' || !flat(s.transform) || s.scale !== 'none' || s.rotate !== 'none' || e.scrollTop || e.scrollLeft) return true
      const r = e.getBoundingClientRect()
      x0 = r.left + px(s.borderLeftWidth)
      y0 = r.top + px(s.borderTopWidth)
    } else {
      for (let a = e; a; a = a.parentElement) {
        const s = getComputedStyle(a)
        if (moved(s) || !noFilter(s.filter) || s.perspective !== 'none' || (s.backdropFilter && s.backdropFilter !== 'none') || /paint|strict|content|layout/.test(s.contain) || /transform|filter|perspective/.test(s.willChange)) return true
      }
      x0 = 0
      y0 = 0
    }
    const extra = (a, b, c, d) => (p.boxSizing === 'border-box' ? 0 : px(a) + px(b) + px(c) + px(d))
    const left = x0 + px(p.left) + px(p.marginLeft)
    const top = y0 + px(p.top) + px(p.marginTop)
    const w = px(p.width) + extra(p.paddingLeft, p.paddingRight, p.borderLeftWidth, p.borderRightWidth)
    const h = px(p.height) + extra(p.paddingTop, p.paddingBottom, p.borderTopWidth, p.borderBottomWidth)
    if (![left, top, w, h].every(Number.isFinite)) return true
    const ix = Math.min(left + w, text.right) - Math.max(left, text.left)
    // A fixed box is over the text whenever the text is scrolled to it: any height will do.
    const iy = p.position === 'fixed' ? h : Math.min(top + h, text.bottom) - Math.max(top, text.top)
    return ix > 0 && iy > 0
  }
  const layersOf = (el) => {
    const text = el.getBoundingClientRect()
    const layers = []
    const images = []
    const effects = []
    let fade = 1
    let animating = false
    let below = false // a background has been seen below this element
    let reached = false // the first opaque background is behind us
    let zSeen = false // a z-index on the opaque element or between it and the current element
    for (let e = el; e; e = e.parentElement) {
      const style = getComputedStyle(e)
      const opacity = Number(style.opacity)
      if (opacityRunning(e)) animating = true
      if (style.mixBlendMode !== 'normal') effects.push('mix-blend-mode')
      if (!noFilter(style.filter)) effects.push('filter')
      for (const pseudo of ['::before', '::after']) if (pseudoOver(el, e, pseudo, text, reached && !zSeen)) effects.push('positioned ' + pseudo + ' with a background')
      if (reached && style.zIndex !== 'auto') zSeen = true
      if (reached) {
        if (opacity < 1) effects.push('opacity')
        continue
      }
      const image = style.backgroundImage && style.backgroundImage !== 'none'
      const c = rgba(style.backgroundColor)
      const has = image || c[3] > 0
      // Behind an opaque background of its own, the backdrop cannot reach the text.
      if (style.backdropFilter && style.backdropFilter !== 'none' && c[3] !== 255) effects.push('backdrop-filter')
      if (opacity < 1) {
        if (!below && !has) fade *= opacity
        else effects.push('opacity')
      }
      if (has && style.backgroundBlendMode.split(',').some((v) => v.trim() !== 'normal')) effects.push('background-blend-mode')
      if (has && [...style.backgroundClip.split(','), ...style.backgroundOrigin.split(',')].some((v) => !BOXES.includes(v.trim()))) effects.push('background-clip')
      if (image) images.push({ value: style.backgroundImage, at: layers.length, size: style.backgroundSize, repeat: style.backgroundRepeat, position: style.backgroundPosition })
      if (c[3] > 0) layers.push(c)
      if (has) below = true
      if (c[3] === 255) {
        reached = true
        zSeen = style.zIndex !== 'auto'
      }
    }
    return { layers, images, fade, animating, effects: [...new Set(effects)] }
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

// Rasterises colour strings (color-mix() included) through a probe element's computed colour and
// the canvas; null for anything CSS does not take as a colour.
const RASTER = `((colours) => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.documentElement.appendChild(probe)
  const out = colours.map((c) => {
    if (!CSS.supports('color', c)) return null
    probe.style.color = ''
    probe.style.color = c
    if (!probe.style.color) return null
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0, 0, 0, 0)'; ctx.fillStyle = getComputedStyle(probe).color; ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data]
  })
  probe.remove()
  return out
})`

// Finite animations (a Motion inView fade, not an infinite spinner) that are still running.
const BUSY = `document.getAnimations().filter((a) => (a.playState === 'running' || a.playState === 'pending') && a.effect && Number.isFinite(a.effect.getComputedTiming().endTime))`
const ANIMATION_TIMEOUT = 5000
/** Until no finite animation runs, or the timeout: true when settled. */
const SETTLED = `new Promise((done) => {
  const t0 = performance.now()
  const tick = () => { const busy = ${BUSY}.length > 0; if (!busy || performance.now() - t0 > ${ANIMATION_TIMEOUT}) done(!busy); else setTimeout(tick, 100) }
  tick()
})`
/** Waits for the running finite animations to finish, or the timeout: true when they did. */
const FINISHED = `Promise.race([Promise.all(${BUSY}.map((a) => a.finished)).then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ${ANIMATION_TIMEOUT}))])`

/** `top` over `below`, unrounded: the worst point of a gradient must not be rounded up past 4.5. */
const over = (top: Rgba, below: Rgb): Rgb => {
  const a = top[3] / 255
  const mix = (t: number, b: number) => a * t + (1 - a) * b
  return { r: mix(top[0], below.r), g: mix(top[1], below.g), b: mix(top[2], below.b) }
}
const round = (c: Rgb): Rgb => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) })

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
const PRELUDE = new Set(['to', 'left', 'right', 'top', 'bottom', 'center', 'circle', 'ellipse', 'closest-side', 'closest-corner', 'farthest-side', 'farthest-corner', 'at', 'from'])
const SPACES = new Set(['srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'lab', 'oklab', 'xyz', 'xyz-d50', 'xyz-d65', 'hsl', 'hwb', 'lch', 'oklch'])
const POLAR = new Set(['hsl', 'hwb', 'lch', 'oklch'])
const HUE = new Set(['shorter', 'longer', 'increasing', 'decreasing'])

/**
 * The colour stops of one computed gradient layer, in order, and its interpolation method when that
 * is not sRGB ('oklch', 'hsl longer hue'). Undefined for anything else (url(), image-set(),
 * currentcolor, a var() left unresolved, a keyword it does not know): the caller is then indeterminate.
 */
export function gradientStops(layer: string): { stops: string[]; method?: string } | undefined {
  const m = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/is.exec(layer.trim())
  if (!m) return undefined
  const args = splitTop(m[1]!, ',')
  const stops: string[] = []
  let method: string | undefined
  for (const [i, arg] of args.entries()) {
    const tokens = splitTop(arg, ' ')
    if (tokens.length && isColour(tokens[0]!)) {
      if (tokens.length > 3 || !tokens.slice(1).every((t) => POSITION.test(t))) return undefined
      stops.push(tokens[0]!)
    } else if (tokens.length === 1 && POSITION.test(tokens[0]!) && stops.length) {
      // A colour hint between two stops: it moves the midpoint, not the colours.
    } else if (i === 0) {
      // Direction, shape, size and position, and an interpolation method ("in hsl longer hue").
      for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k]!.toLowerCase()
        if (t !== 'in') {
          if (!PRELUDE.has(t) && !POSITION.test(t)) return undefined
          continue
        }
        const space = tokens[k + 1]?.toLowerCase()
        if (method !== undefined || !space || !SPACES.has(space)) return undefined
        method = space
        k++
        const hue = tokens[k + 1]?.toLowerCase()
        if (hue && HUE.has(hue)) {
          if (!POLAR.has(space) || tokens[k + 2]?.toLowerCase() !== 'hue') return undefined
          method += ` ${hue} hue`
          k += 2
        }
      }
    } else return undefined
  }
  if (stops.length < 2) return undefined
  // Stops that are not all legacy sRGB colours interpolate in oklab by default (CSS Color 4).
  if (method === undefined && !stops.every((c) => LEGACY.test(c))) method = 'oklab'
  if (method === 'srgb') method = undefined
  return method ? { stops, method } : { stops }
}

/** Whether an image layer covers the whole box: it repeats, or is the box's size at its origin. */
const covers = (size: string, repeat: string, position: string) =>
  /^repeat(?: repeat)?$/.test(repeat) || (/^(?:auto(?: auto)?|cover|100% 100%)$/.test(size) && /^(?:0%(?: 0%)?|0px 0px)$/.test(position))

const pct = (n: number) => Number(n.toFixed(4))
/** The color-mix() the page resolves for a point t (0..1) between stops a and b. */
const mixKey = (method: string, a: string, b: string, t: number) => `color-mix(in ${method}, ${a} ${pct(100 - pct(t * 100))}%, ${b} ${pct(t * 100)}%)`

type Gradient = { stops: string[]; method?: string; covers: boolean }
type Entry = { kind: 'colour'; c: Rgba } | ({ kind: 'gradient' } & Gradient) | { kind: 'unknown' }

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
      if (!g) es.push({ kind: 'unknown' })
      else es.push({ kind: 'gradient', ...g, covers: covers(nth(sizes, i, 'auto'), nth(repeats, i, 'repeat'), nth(positions, i, '0% 0%')) })
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

/** Opaque everywhere and covering the box; for a gradient, every stop opaque (any mix of them is too). */
const opaqueCover = (e: Entry, colours: RawContrast['colours']) =>
  e.kind === 'colour' ? e.c[3] === 255 : e.kind === 'gradient' && e.covers && e.stops.every((s) => colours?.[s]?.[3] === 255)

const GRID = 64
const REFINE = 32
const LEVELS = 2
const MINIMA = 8

/**
 * The minimum of f on [0, 1]: a grid, then two finer grids around each of the lowest local minima.
 * f returns undefined for a point it cannot evaluate yet (a mix the page has not resolved); the
 * search then stops at that level and returns undefined, having asked f for every point of it.
 */
function minimise(f: (t: number) => number | undefined): { t: number; v: number } | undefined {
  const grid = Array.from({ length: GRID + 1 }, (_, k) => k / GRID)
  const vals = grid.map(f)
  if (vals.some((v) => v === undefined)) return undefined
  const vs = vals as number[]
  let best = { t: 0, v: Infinity }
  for (const [k, v] of vs.entries()) if (v < best.v) best = { t: grid[k]!, v }
  const minima = vs
    .map((v, k) => ({ k, v }))
    .filter(({ k, v }) => v <= (vs[k - 1] ?? Infinity) && v <= (vs[k + 1] ?? Infinity))
    .sort((a, b) => a.v - b.v)
    .slice(0, MINIMA)
  let pending = false
  for (const { k } of minima) {
    let centre = grid[k]!
    let h = 1 / GRID
    for (let level = 0; level < LEVELS; level++) {
      const ts = Array.from({ length: REFINE + 1 }, (_, j) => Math.min(1, Math.max(0, centre - h + (2 * h * j) / REFINE)))
      const got = ts.map(f)
      if (got.some((v) => v === undefined)) {
        pending = true
        break
      }
      let j = 0
      for (let i = 1; i < got.length; i++) if (got[i]! < got[j]!) j = i
      centre = ts[j]!
      if (got[j]! < best.v) best = { t: centre, v: got[j]! }
      h = (2 * h) / REFINE
    }
  }
  return pending ? undefined : best
}

/** Premultiplied sRGB interpolation, as browsers paint a gradient without an `in` method. */
const lerpSrgb = (a: Rgba, b: Rgba, t: number): Rgba => {
  const alpha = a[3] + (b[3] - a[3]) * t
  const ch = (j: number) => (alpha === 0 ? 0 : (a[j]! * a[3] + (b[j]! * b[3] - a[j]! * a[3]) * t) / alpha)
  return [ch(0), ch(1), ch(2), alpha]
}

interface Evaluated {
  row: ContrastRow
  /** Colour strings the page still has to resolve before this row can be measured. */
  missing: string[]
}

function evaluate(r: RawContrast): Evaluated {
  const missing = new Set<string>()
  const colour = (s: string): Rgba | undefined => {
    const c = r.colours?.[s]
    if (c === undefined) missing.add(s)
    return c ?? undefined
  }
  const fgBase: Rgba = [r.fg[0], r.fg[1], r.fg[2], r.fg[3] * (r.fade ?? 1)]
  const es = entries(r)
  // Everything beneath the topmost opaque layer that covers the box is hidden.
  let start = es.length - 1
  while (start >= 0 && !opaqueCover(es[start]!, r.colours)) start--
  const opaque = start >= 0
  const shown = es.slice(Math.max(0, start))
  const gradients = shown.filter((e) => e.kind === 'gradient')
  const unknown = shown.some((e) => e.kind === 'unknown')
  // Colours beneath the (single) gradient, composited, and the colour layers above it.
  const gi = shown.findIndex((e) => e.kind === 'gradient')
  const colours = (es: Entry[]) => es.filter((e): e is { kind: 'colour'; c: Rgba } => e.kind === 'colour')
  let beneath = WHITE
  for (const e of colours(gi < 0 ? shown : shown.slice(0, gi))) beneath = over(e.c, beneath)
  const above = gi < 0 ? [] : colours(shown.slice(gi + 1))
  const withAbove = (bg: Rgb) => above.reduce((b, e) => over(e.c, b), bg)
  const ratioOn = (bg: Rgb) => wcagContrast(over(fgBase, bg), bg)

  type Worst = { bg: Rgb; ratio: number; stop: boolean }
  let worst: Worst = { bg: withAbove(beneath), ratio: ratioOn(withAbove(beneath)), stop: true }
  let unresolved = false
  const g = gradients.length === 1 ? (gradients[0] as { kind: 'gradient' } & Gradient) : undefined
  if (g) {
    const stops = g.stops.map(colour)
    if (stops.some((c) => c === undefined)) unresolved = true
    else {
      const bgOf = (c: Rgba) => withAbove(over(c, beneath))
      const found: Worst[] = []
      for (let i = 1; i < g.stops.length; i++) {
        const [a, b] = [stops[i - 1]!, stops[i]!]
        const at = (t: number): Rgba | undefined =>
          !g.method || t === 0 || t === 1 ? (t === 0 ? a : t === 1 ? b : lerpSrgb(a, b, t)) : colour(mixKey(g.method, g.stops[i - 1]!, g.stops[i]!, t))
        const min = minimise((t) => {
          const c = at(t)
          return c && ratioOn(bgOf(c))
        })
        if (!min) unresolved = true
        else found.push({ bg: bgOf(at(min.t)!), ratio: min.v, stop: min.t === 0 || min.t === 1 })
      }
      if (!g.covers) found.push(worst)
      worst = found.reduce((w, x) => (x.ratio < w.ratio - 1e-9 || (Math.abs(x.ratio - w.ratio) <= 1e-9 && x.stop && !w.stop) ? x : w), {
        bg: WHITE,
        ratio: Infinity,
        stop: true,
      })
      if (!Number.isFinite(worst.ratio)) worst = { bg: withAbove(beneath), ratio: ratioOn(withAbove(beneath)), stop: true }
    }
  }
  const effects = r.effects ?? []
  const indeterminate = r.animating
    ? 'animation not settled'
    : effects.length
    ? `effect on the text or its background: ${effects.join(', ')}`
    : unknown
      ? 'background image behind the text'
      : gradients.length > 1
        ? 'more than one gradient behind the text'
        : unresolved
          ? 'gradient colour the page did not resolve'
          : !opaque
            ? 'no opaque background; composited over white'
            : undefined
  const note =
    g && !unresolved ? `gradient, ${worst.stop ? 'worst stop' : 'worst point between stops'}${g.method ? `; interpolated in ${g.method}` : ''}` : undefined
  const row: ContrastRow = {
    kind: r.kind,
    button: r.label,
    ratio: worst.ratio,
    ok: worst.ratio >= 4.5 && !indeterminate,
    fg: round(over(fgBase, worst.bg)),
    bg: round(worst.bg),
    ...(indeterminate ? { indeterminate } : {}),
    ...(note ? { note } : {}),
  }
  return { row, missing: [...missing] }
}

/** Pure: composites the page's raw colours and computes the WCAG ratio for each row. */
export function contrastRows(raw: RawContrast[]): ContrastRow[] {
  return raw.map((r) => evaluate(r).row)
}

/** The stop and color-mix() strings the rows still need the page to resolve. */
export function pendingColours(raw: RawContrast[]): string[] {
  return [...new Set(raw.flatMap((r) => evaluate(r).missing))]
}

/** Banner buttons, PrivacyLinks text and unloaded embed placeholders on the page as it is now. */
export async function measureContrast(page: Pick<Page, 'evaluate'>): Promise<ContrastRow[]> {
  let raw = (await page.evaluate(MEASURE)) as RawContrast[]
  // A scroll-in fade still running on the way: wait for it once, then read again.
  if (raw.some((r) => r.animating)) {
    await page.evaluate(FINISHED)
    raw = (await page.evaluate(MEASURE)) as RawContrast[]
  }
  const colours: Record<string, Rgba | null> = {}
  for (const r of raw) r.colours = colours
  // Stops first, then the grid and each refinement level of any non-sRGB segment: a few rounds.
  for (let round = 0; round < 6; round++) {
    const wanted = pendingColours(raw)
    if (!wanted.length) break
    const got = (await page.evaluate(`${RASTER}(${JSON.stringify(wanted)})`)) as (Rgba | null)[]
    for (const [i, c] of wanted.entries()) colours[c] = got[i] ?? null
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
      // Scrolled through and back, as the request check does: the starter's [data-animate] is
      // opacity 0 until Motion's inView fades it in, and ~25 sites wrap an embed in one.
      await open(page, base, path)
      // DaisyUI buttons animate colour changes; read the settled value.
      await page.addStyleTag({ content: '* { transition: none !important }' })
      await page.waitForTimeout(300)
      await page.evaluate(SETTLED)
      for (const row of await measureContrast(page)) rows.push({ path, ...row })
    } finally {
      await context.close()
    }
  }
  return rows
}
