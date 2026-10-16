// Map heights (#46, part of spec C3 step 5): a placeholder must be about as tall as the iframe it
// replaced. Step 5's clip rows only say whether the buttons fit, so a map that went from 460px to
// 320px with an empty band below (knutssonsbil: an in-flow wrapper inside a padding-ratio box whose
// iframe was absolute) passed. Main's registry iframes and the branch's ConsentEmbed placeholders
// are measured at the same widths and paired in page order.
import type { Browser } from '@playwright/test'
import { matchesRegistry } from '../../../src/services'
import { freshPage, gotoPage } from './requests'

export interface EmbedBox {
  path: string
  width: number
  /** Rounded layout height and width of the box, px. */
  h: number
  w: number
}

export interface EmbedHeightRow {
  path: string
  width: number
  /** 1-based position of the embed on the page. */
  index: number
  mainH: number
  branchH: number
  ok: boolean
}

/** A placeholder may be this much shorter than main's iframe (rounding, a border, a 1px gap). */
export const SHORTER_BY = 0.1

/**
 * Pure: pairs main's boxes with the branch's per path and width, in page order. A page where the
 * counts differ is not compared (a map main built in a script, stromsbacka) and gets a note.
 */
export function compareEmbedHeights(main: EmbedBox[], branch: EmbedBox[]): { rows: EmbedHeightRow[]; notes: string[] } {
  const key = (b: EmbedBox) => `${b.path} ${b.width}`
  const group = (boxes: EmbedBox[]) => {
    const m = new Map<string, EmbedBox[]>()
    for (const b of boxes) m.set(key(b), [...(m.get(key(b)) ?? []), b])
    return m
  }
  const onMain = group(main)
  const rows: EmbedHeightRow[] = []
  const notes: string[] = []
  for (const [k, ours] of group(branch)) {
    const theirs = onMain.get(k) ?? []
    if (theirs.length !== ours.length) {
      notes.push(`${k}px: ${theirs.length} map iframe${theirs.length === 1 ? '' : 's'} on main, ${ours.length} embed${ours.length === 1 ? '' : 's'} on the branch: heights not compared`)
      continue
    }
    ours.forEach((b, i) => {
      const mainH = theirs[i]!.h
      rows.push({ path: b.path, width: b.width, index: i + 1, mainH, branchH: b.h, ok: b.h >= mainH * (1 - SHORTER_BY) })
    })
  }
  return { rows, notes }
}

// Passed as a string: tsx adds __name helpers to functions, which don't exist in the page.
// Main: every iframe with its src (registry matching happens in Node). Branch: every iframe
// ConsentEmbed that has not loaded (a widget has no iframe on main to compare with).
const MEASURE = `(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width) } }
  return {
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.getAttribute('src') || f.getAttribute('data-src') || '', ...box(f) })),
    embeds: [...document.querySelectorAll('[data-consent-embed]:not([data-script]):not([data-active])')].map(box),
  }
})()`

/**
 * Each path at each width in a fresh page: the boxes of registry iframes (main) or of unloaded
 * ConsentEmbed placeholders (branch), whichever the page has. A page with both is the branch.
 */
export async function checkEmbedBoxes(
  browser: Browser,
  base: string,
  paths: string[],
  widths: number[] = [360, 1280],
  opts: { stub?: boolean } = {},
): Promise<EmbedBox[]> {
  const boxes: EmbedBox[] = []
  for (const path of paths) {
    for (const width of widths) {
      const { context, page } = await freshPage(browser, opts.stub ?? true, { width, height: 800 })
      try {
        await gotoPage(page, base + path)
        await page.waitForTimeout(300)
        const m = (await page.evaluate(MEASURE)) as { iframes: { src: string; h: number; w: number }[]; embeds: { h: number; w: number }[] }
        const found = m.embeds.length ? m.embeds : m.iframes.filter((f) => matchesRegistry(f.src))
        for (const b of found) boxes.push({ path, width, h: b.h, w: b.w })
      } finally {
        await context.close()
      }
    }
  }
  return boxes
}
