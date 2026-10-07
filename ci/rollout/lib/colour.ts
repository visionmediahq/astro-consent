// Colour maths for the banner's button-text rule (src/styles/contrast.css) and for tools that
// need to predict what that rule picks. Browser-safe and dependency-free.

export type Rgb = { r: number; g: number; b: number } // 0..255

const toLinear = (c: number): number => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const fromLinear = (v: number): number => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.min(255, Math.max(0, s * 255))
}

/** OKLab lightness (0..1) of an sRGB colour, using Ottosson's published matrices. */
export function oklchL({ r, g, b }: Rgb): number {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
}

/** WCAG 2 relative luminance. */
const luminance = ({ r, g, b }: Rgb): number =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)

/** WCAG 2 contrast ratio (1..21), argument order does not matter. */
export function wcagContrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** What contrast.css does: white text on primaries darker than lCut, black on the rest. */
export function pickText(primary: Rgb, lCut: number): 'black' | 'white' {
  return oklchL(primary) < lCut ? 'white' : 'black'
}

/** The cut-off in contrast.css: the number in "(L_CUT - l)", not the @supports probe's 0.6. */
export function readLCut(cssText: string): number {
  const withoutProbe = cssText.replace(/@supports[^{]*\{/, '')
  const m = /\(\s*([0-9.]+)\s*-\s*l\s*\)/.exec(withoutProbe)
  if (!m) throw new Error('no "(L_CUT - l)" in the css')
  return Number(m[1])
}

function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

const num = (s: string): number => {
  const t = s.trim()
  return t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t)
}

/** Accepts #rgb, #rrggbb, rgb(r, g, b) and oklch(L C H); oklch is gamut-clamped to sRGB. */
export function parseColour(css: string): Rgb {
  const s = css.trim().toLowerCase()
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (m) {
    const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  m = /^rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/.exec(s)
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
  m = /^oklch\(\s*([^\s,)]+)[\s,]+([^\s,)]+)[\s,]+([^\s,)]+)\s*(?:\/[^)]*)?\)$/.exec(s)
  if (m) {
    const L = num(m[1]!)
    const C = m[2]!.endsWith('%') ? (Number(m[2]!.slice(0, -1)) / 100) * 0.4 : Number(m[2])
    const H = (Number(m[3]!.replace('deg', '')) * Math.PI) / 180
    return oklabToRgb(L, C * Math.cos(H), C * Math.sin(H))
  }
  throw new Error(`cannot parse colour: ${css}`)
}
