// Site-wide styles on html and body, compared with main in step 5. daisyUI added where main had none
// (faluridklubb) restyled the scrollbar on every page (`scrollbar-color` on :root) and painted :root
// with its own background. Screenshots cannot show the scrollbar: Playwright hides it.
import type { Browser } from '@playwright/test'
import { freshPage, gotoPage } from './requests'

/** 'html scrollbar-color' → its computed value. */
export type RootStyles = Record<string, string>

// Only what shows on screen: daisyUI's `color` on :root is reset by most sites' body text colour, and
// its `color-scheme: light` renders as the default, so comparing those would fail sites that are fine.
const PROPS = {
  html: ['scrollbar-color', 'scrollbar-width', 'scrollbar-gutter', 'background-color'],
  body: ['background-color'],
} as const

// Passed as a string: tsx adds __name helpers to functions, which don't exist in the page.
const MEASURE = `((props) => {
  const out = {}
  for (const [tag, names] of Object.entries(props)) {
    const s = getComputedStyle(tag === 'html' ? document.documentElement : document.body)
    for (const n of names) out[tag + ' ' + n] = s.getPropertyValue(n)
  }
  return out
})(${JSON.stringify(PROPS)})`

/** The root styles of one page at 1280 px. */
export async function checkRootStyles(browser: Browser, base: string, path = '/', opts: { stub?: boolean } = {}): Promise<RootStyles> {
  const { context, page } = await freshPage(browser, opts.stub ?? true, { width: 1280, height: 800 })
  try {
    await gotoPage(page, base + path)
    return (await page.evaluate(MEASURE)) as RootStyles
  } finally {
    await context.close()
  }
}

/** One line per property whose value differs: `html scrollbar-color: main auto, branch …`. */
export function diffRootStyles(main: RootStyles, branch: RootStyles): string[] {
  return [...new Set([...Object.keys(main), ...Object.keys(branch)])]
    .filter((k) => main[k] !== branch[k])
    .map((k) => `${k}: main ${main[k] ?? '(none)'}, branch ${branch[k] ?? '(none)'}`)
}
