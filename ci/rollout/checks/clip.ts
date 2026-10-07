// Clipped buttons (spec C3 step 5), ported from the pilot kit's clip.ts. The pilot checked the
// embed's "Visa" at 320/360/375 px; this checks every visible banner and embed button, plus 1280.
import type { Browser } from '@playwright/test'
import { freshPage } from './requests'

export interface ClipResult {
  path: string
  width: number
  button: string
  /** Button width and its container's width, rounded px. */
  w: number
  boxW: number
  /** The text overflows the button: scrollWidth > clientWidth. */
  over: boolean
  /** The button sticks out of its container (right edge, or left edge). */
  out: boolean
  clipped: boolean
}

// Passed as a string: tsx adds __name helpers to functions, which don't exist in the page.
const MEASURE = `(() => {
  const rows = []
  const buttons = document.querySelectorAll('[data-consent-banner] button, [data-consent-embed] button')
  for (const b of buttons) {
    const bb = b.getBoundingClientRect()
    if (!b.offsetParent || bb.width === 0) continue
    const box = (b.closest('[data-consent-embed]') || b.closest('.card-body') || b.closest('[data-consent-banner]')).getBoundingClientRect()
    rows.push({
      button: (b.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
      w: Math.round(bb.width),
      boxW: Math.round(box.width),
      over: b.scrollWidth > b.clientWidth + 1,
      out: bb.right > box.right + 1 || bb.left < box.left - 1,
    })
  }
  return rows
})()`

/** Every path at every width, one fresh page each; rows for every visible banner and embed button. */
export async function checkClip(
  browser: Browser,
  base: string,
  paths: string[],
  widths: number[] = [320, 360, 375, 1280],
  opts: { stub?: boolean } = {},
): Promise<ClipResult[]> {
  const results: ClipResult[] = []
  for (const path of paths) {
    for (const width of widths) {
      const { context, page } = await freshPage(browser, opts.stub ?? true, { width, height: 800 })
      try {
        await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 })
        await page.waitForTimeout(300)
        const rows = (await page.evaluate(MEASURE)) as Omit<ClipResult, 'path' | 'width' | 'clipped'>[]
        for (const r of rows) results.push({ path, width, ...r, clipped: r.over || r.out })
      } finally {
        await context.close()
      }
    }
  }
  return results
}
