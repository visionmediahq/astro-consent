// Clipped buttons (spec C3 step 5), ported from the pilot kit's clip.ts. The pilot checked the
// embed's "Visa" at 320/360/375 px; this checks every visible banner and embed button, plus 1280,
// and that no overflow:hidden ancestor cuts an embed button off.
import type { Browser } from '@playwright/test'
import { freshPage, gotoPage } from './requests'

export interface ClipResult {
  path: string
  width: number
  /** 'button': one banner or embed button. 'page': the page itself (horizontal scroll). */
  kind: 'button' | 'page'
  /** The button's text, or '(page)'. */
  button: string
  /** Button width and its container's width, rounded px (page: scrollWidth and innerWidth). */
  w: number
  boxW: number
  /** The text overflows the button: scrollWidth > clientWidth. Page: it scrolls sideways. */
  over: boolean
  /** The button sticks out of its container or out of the viewport (right edge, or left edge). */
  out: boolean
  /**
   * A banner button another element covers (a site's fixed call bar on top of the banner): one of
   * five points inside it (centre, and 25 % in from each edge) hits something that is not the
   * button. Embed buttons are not hit-tested, as they can sit below the fold.
   */
  covered: boolean
  /**
   * An embed button, or the rest of its row ("Visa alltid", the open link), that an ancestor with
   * `overflow: hidden` or `clip` cuts off, wholly or in part, on the axis it hides (lbfastigheter,
   * #43: a map parent 300px tall on phones hid "Visa" below its edge). An axis that scrolls is not
   * counted: the visitor can scroll to the button.
   */
  cut: boolean
  clipped: boolean
}

// Passed as a string: tsx adds __name helpers to functions, which don't exist in the page.
const MEASURE = `(() => {
  const rows = [{
    kind: 'page',
    button: '(page)',
    w: document.documentElement.scrollWidth,
    boxW: innerWidth,
    over: document.documentElement.scrollWidth > innerWidth,
    out: false,
    covered: false,
    cut: false,
  }]
  const buttons = document.querySelectorAll('[data-consent-banner] button, [data-consent-embed] button')
  for (const b of buttons) {
    const bb = b.getBoundingClientRect()
    if (!b.offsetParent || bb.width === 0) continue
    const box = (b.closest('[data-consent-embed]') || b.closest('.card-body') || b.closest('[data-consent-banner]')).getBoundingClientRect()
    rows.push({
      kind: 'button',
      button: (b.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
      w: Math.round(bb.width),
      boxW: Math.round(box.width),
      over: b.scrollWidth > b.clientWidth + 1,
      out: bb.right > box.right + 1 || bb.left < box.left - 1 || bb.right > innerWidth + 1 || bb.left < -1,
      covered: !!b.closest('[data-consent-banner]') && [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]].some(([fx, fy]) => {
        const hit = document.elementFromPoint(bb.left + bb.width * fx, bb.top + bb.height * fy)
        return !hit || !b.contains(hit)
      }),
      cut: !!b.closest('[data-consent-embed]') && (() => {
        // The button and the rest of its row: "Visa alltid" and the open link can wrap below it.
        const embed = b.closest('[data-consent-embed]')
        const parts = [b, embed.querySelector('[data-remember]')?.closest('label'), embed.querySelector('a[data-open]')]
          .filter((el) => el && el.offsetParent)
          .map((el) => el.getBoundingClientRect())
        const hides = (o) => o === 'hidden' || o === 'clip'
        for (let a = b.parentElement; a && a !== document.documentElement; a = a.parentElement) {
          const s = getComputedStyle(a)
          // Per axis: overflow-x: hidden makes overflow-y auto, which scrolls.
          const x = hides(s.overflowX)
          const y = hides(s.overflowY)
          if (!x && !y) continue
          const r = a.getBoundingClientRect()
          for (const p of parts) {
            if (y && (p.top < r.top - 1 || p.bottom > r.bottom + 1)) return true
            if (x && (p.left < r.left - 1 || p.right > r.right + 1)) return true
          }
        }
        return false
      })(),
    })
  }
  return rows
})()`

/**
 * Every path at every width, one fresh page each: a 'page' row (horizontal scroll) and a row for
 * every visible banner and embed button.
 */
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
        await gotoPage(page, base + path)
        await page.waitForTimeout(300)
        const rows = (await page.evaluate(MEASURE)) as Omit<ClipResult, 'path' | 'width' | 'clipped'>[]
        for (const r of rows) results.push({ path, width, ...r, clipped: r.over || r.out || r.covered || r.cut })
      } finally {
        await context.close()
      }
    }
  }
  return results
}
