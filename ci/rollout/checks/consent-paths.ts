// Consent paths on map pages (spec C3 step 4), ported from the pilot kit's remember.ts (Visa alltid
// carries over), filter.ts (a CSS filter survives the wiring) and openlink.ts (the embed's "Öppna i"
// link). Buttons are found through the DOM contract, not their Swedish labels.
import type { Browser, Page } from '@playwright/test'
import { matchesRegistry } from '../../../src/services'
import { bannerState, freshPage, open, recordBlocked } from './requests'

export interface ConsentPathResult {
  path: string
  /**
   * After Neka, clicking "Visa" on the first embed loads that embed's iframe and no other, every
   * registry request after the click belongs to that embed's service, and after a reload no embed
   * is loaded (the grant was one-off).
   */
  visaLoadsOnlyClicked: boolean
  /** "Visa alltid" + "Visa", then the next map page (or a reload): its embeds load without a click. */
  rememberAutoShows: boolean
  /** After Neka: no registry request, no iframe, banner closed. */
  nekaLoadsNothing: boolean
  /**
   * The loaded iframe keeps a CSS filter (filter.ts). null when the caller did not say a filter is
   * expected (`expectFilter`): not asserted, and never to be read as a pass.
   */
  filterKept: boolean | null
  /** The loaded iframe's computed filter, for the evidence. */
  filter: string
  /** The first embed's "Öppna i" link, for the evidence (openlink.ts opened it; we don't). */
  openHref: string | null
  notes: string[]
}

const embeds = (page: Page) => page.locator('[data-consent-embed]')
const iframes = (page: Page) => page.locator('[data-consent-embed] iframe')

/** Clicks Neka in the banner. False (with a note) unless exactly one banner is really shown. */
async function decline(page: Page, notes: string[], what: string): Promise<boolean> {
  const state = await bannerState(page)
  if (!state.shown) {
    notes.push(`${what}: banner not shown (${state.problem ?? 'unknown'}), could not click Neka`)
    return false
  }
  await page.locator('[data-consent-banner] [data-consent-action="none"]').click()
  await page.waitForTimeout(300)
  return true
}

async function visaOnlyClicked(browser: Browser, base: string, path: string, stub: boolean, notes: string[]) {
  const { context, page } = await freshPage(browser, stub)
  try {
    const hits = recordBlocked(page)
    await open(page, base, path)
    const declined = await decline(page, notes, 'visa')
    const count = await embeds(page).count()
    if (count === 0) {
      notes.push('visa: no [data-consent-embed] on the page')
      return { ok: false, filter: 'none', openHref: null }
    }
    const first = embeds(page).first()
    const service = await first.getAttribute('data-consent-embed')
    const openHref = await first.locator('a[data-open]').getAttribute('href')
    await first.scrollIntoViewIfNeeded()
    const before = hits.length
    await first.locator('[data-load]').click()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(1000)
    const own = await first.locator('iframe').count()
    const total = await iframes(page).count()
    const active = await first.getAttribute('data-active')
    const filter = own ? await first.locator('iframe').evaluate((f) => getComputedStyle(f).filter) : 'none'
    const foreign = hits.slice(before).filter((u) => matchesRegistry(u) !== service)
    const afterClick = hits.length
    // One-off: a reload must show no embed and request nothing from the registry.
    await open(page, base, path)
    const reloaded = await iframes(page).count()
    const afterReload = hits.length - afterClick
    const ok = declined && before === 0 && own === 1 && total === 1 && active !== null && foreign.length === 0 && reloaded === 0 && afterReload === 0
    if (!ok) {
      notes.push(
        `visa: before click blocked=${before}; clicked iframe=${own}, iframes on page=${total} of ${count} embeds, data-active=${active !== null}; ` +
          `other services=${JSON.stringify(foreign.slice(0, 3))}; after reload iframes=${reloaded} blocked=${afterReload}`,
      )
    }
    return { ok, filter, openHref }
  } finally {
    await context.close()
  }
}

async function rememberCarries(browser: Browser, base: string, a: string, b: string, stub: boolean, notes: string[]) {
  const { context, page } = await freshPage(browser, stub)
  try {
    await open(page, base, a)
    if (!(await decline(page, notes, 'remember'))) return false
    const first = embeds(page).first()
    if (!(await first.count())) return false
    await first.scrollIntoViewIfNeeded()
    await first.locator('[data-remember]').check()
    await first.locator('[data-load]').click()
    await page.waitForTimeout(1000)
    const aLoaded = await first.locator('iframe').count()
    await open(page, base, b)
    const bEmbeds = await embeds(page).count()
    const bLoaded = await iframes(page).count()
    const bannerB = (await bannerState(page)).open
    const ok = aLoaded === 1 && bEmbeds > 0 && bLoaded === bEmbeds && !bannerB
    if (!ok) notes.push(`remember: ${a} iframe=${aLoaded}; ${b} iframes=${bLoaded}/${bEmbeds} banner=${bannerB}`)
    return ok
  } finally {
    await context.close()
  }
}

async function nekaNothing(browser: Browser, base: string, path: string, stub: boolean, notes: string[]) {
  const { context, page } = await freshPage(browser, stub)
  try {
    const hits = recordBlocked(page)
    await open(page, base, path)
    const declined = await decline(page, notes, 'neka')
    await page.mouse.wheel(0, 20000)
    await page.waitForTimeout(1500)
    const loaded = await iframes(page).count()
    const banner = (await bannerState(page)).open
    const ok = declined && hits.length === 0 && loaded === 0 && !banner
    if (!ok) notes.push(`neka: declined=${declined} blocked=${hits.length} iframes=${loaded} banner=${banner}`)
    return ok
  } finally {
    await context.close()
  }
}

/**
 * Runs the three consent paths on each map page, each in a fresh context. `stub` (default true)
 * fulfils registry requests locally, so clicking "Visa" never reaches Google; pass false on live
 * runs. `expectFilter(path)` says whether the site's map had a CSS filter that wire carried over.
 */
export async function checkConsentPaths(
  browser: Browser,
  base: string,
  mapPaths: string[],
  opts: { stub?: boolean; expectFilter?: (path: string) => boolean } = {},
): Promise<ConsentPathResult[]> {
  const stub = opts.stub ?? true
  const results: ConsentPathResult[] = []
  for (const [i, path] of mapPaths.entries()) {
    const notes: string[] = []
    const visa = await visaOnlyClicked(browser, base, path, stub, notes)
    const next = mapPaths[(i + 1) % mapPaths.length]!
    const rememberAutoShows = await rememberCarries(browser, base, path, next, stub, notes)
    const nekaLoadsNothing = await nekaNothing(browser, base, path, stub, notes)
    const filterKept = opts.expectFilter?.(path) ? visa.filter !== 'none' : null
    if (filterKept === false) notes.push('filter: expected a CSS filter on the loaded iframe, got none')
    results.push({
      path,
      visaLoadsOnlyClicked: visa.ok,
      rememberAutoShows,
      nekaLoadsNothing,
      filterKept,
      filter: visa.filter,
      openHref: visa.openHref,
      notes,
    })
  }
  return results
}
