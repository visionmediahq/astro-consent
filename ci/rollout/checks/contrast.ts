// Contrast (spec C3 step 6), ported from the pilot kit's contrast.ts. The page rasterises each
// computed colour through a canvas, because Chromium can serialise them as oklch(), oklab(… / a) or
// color(srgb …); the ratio is computed here with lib/colour.ts.
//
// Effective background: from the element up, every background colour until the first opaque one,
// composited outside-in. Text with alpha is composited over that. A background image on the way, or
// no opaque background at all (composited over the white canvas then), makes the row indeterminate:
// the ratio is still given, but it is not proof: such a row's `ok` is always false. DaisyUI's noise texture on buttons (an inline SVG
// feTurbulence at 20 % opacity) is decoration on top of the button colour and does not count.
import type { Browser, Page } from '@playwright/test'
import { type Rgb, wcagContrast } from '../lib/colour'
import { freshPage } from './requests'

type Rgba = [number, number, number, number] // 0..255, alpha too

export interface RawContrast {
  kind: 'banner' | 'links'
  label: string
  /** Text colour as the canvas returns it. */
  fg: Rgba
  /** Background colours from the element outwards, up to and including the first opaque one. */
  layers: Rgba[]
  /** Computed background-image values (other than 'none') on the way to the first opaque background. */
  images: string[]
}

export interface ContrastRow {
  path?: string
  /** 'banner': a visible banner button. 'links': a PrivacyLinks button or link. */
  kind: 'banner' | 'links'
  /** The button's or link's text. */
  button: string
  ratio: number
  /** ratio ≥ 4.5 and not indeterminate. An indeterminate row is never a pass, whatever its ratio. */
  ok: boolean
  fg: Rgb
  bg: Rgb
  indeterminate?: string
}

// Passed as a string: tsx adds __name helpers to functions, which don't exist in the page.
const MEASURE = `(() => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0, 0, 0, 0)'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
  const layersOf = (el) => {
    const layers = []
    const images = []
    for (let e = el; e; e = e.parentElement) {
      const style = getComputedStyle(e)
      if (style.backgroundImage && style.backgroundImage !== 'none') images.push(style.backgroundImage)
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
  ]
})()`

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

/** Pure: composites the page's raw colours and computes the WCAG ratio for each row. */
export function contrastRows(raw: RawContrast[]): ContrastRow[] {
  return raw.map((r) => {
    const opaque = r.layers.at(-1)?.[3] === 255
    let bg = WHITE
    for (const layer of [...r.layers].reverse()) bg = over(layer, bg)
    const fg = over(r.fg, bg)
    const ratio = wcagContrast(fg, bg)
    const indeterminate = r.images.some(coversBackground)
      ? 'background image behind the text'
      : !opaque
        ? 'no opaque background; composited over white'
        : undefined
    return { kind: r.kind, button: r.label, ratio, ok: ratio >= 4.5 && !indeterminate, fg, bg, ...(indeterminate ? { indeterminate } : {}) }
  })
}

/** Banner buttons and PrivacyLinks text on the page as it is now. */
export async function measureContrast(page: Pick<Page, 'evaluate'>): Promise<ContrastRow[]> {
  return contrastRows((await page.evaluate(MEASURE)) as RawContrast[])
}

/**
 * Opens each path (default '/') in a fresh context and measures the visible banner buttons and the
 * PrivacyLinks text against their effective backgrounds. Step 6 wants every ratio ≥ 4.5.
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
      await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 })
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
