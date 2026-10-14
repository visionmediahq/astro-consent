// Consent paths on map pages (spec C3 step 4), ported from the pilot kit's remember.ts (Visa alltid
// carries over), filter.ts (a CSS filter survives the wiring) and openlink.ts (the embed's "Öppna i"
// link). Buttons are found through the DOM contract, not their Swedish labels.
import type { Browser, Page } from '@playwright/test'
import { matchesRegistry, type ServiceSlug } from '../../../src/services'
import { bannerState, freshPage, open, recordBlocked } from './requests'

export interface ConsentPathResult {
  path: string
  /**
   * After Neka, clicking "Visa" on the first embed loads that embed's iframe and no other, every
   * registry request after the click belongs to that embed's service, and after a reload no embed
   * is loaded (the grant was one-off).
   */
  visaLoadsOnlyClicked: boolean
  /**
   * "Visa alltid" + "Visa" on the first embed (service S), then the next page that has S (or a
   * reload when no other page has it): its S embeds activate without a click, embeds of other
   * services stay placeholders, and no banner opens.
   */
  rememberAutoShows: boolean
  /** After Neka: no registry request, no iframe, banner closed. */
  nekaLoadsNothing: boolean
  /**
   * The loaded iframe of the filtered service keeps a CSS filter (filter.ts). null when the caller
   * did not say a filter is expected (`expectFilter`), or the page has no embed of that service: not
   * asserted, and never to be read as a pass.
   */
  filterKept: boolean | null
  /**
   * The computed filter of the iframe read for `filterKept`: the first embed's, or the first embed of
   * the filtered service's when the first embed is of another service. For the evidence.
   */
  filter: string
  /** The first embed's "Öppna i" link, for the evidence (openlink.ts opened it; we don't). null for a widget, which has none. */
  openHref: string | null
  notes: string[]
}

const embeds = (page: Page) => page.locator('[data-consent-embed]')
const iframes = (page: Page) => page.locator('[data-consent-embed] iframe')
/** Activated embeds: an iframe embed or a script widget (which has no iframe of its own). */
const active = (page: Page) => page.locator('[data-consent-embed][data-active]')

/**
 * The pages to try, in order, for carrying "Visa alltid" over from `paths[i]`: every other page
 * starting with the next one, then `paths[i]` itself (a reload) as the fallback.
 */
export function rememberCandidates(paths: string[], i: number): string[] {
  const others = paths.map((_, k) => paths[(i + 1 + k) % paths.length]!).filter((p, k) => (i + 1 + k) % paths.length !== i)
  return [...others, paths[i]!]
}

export interface RememberCounts {
  /** The clicked embed is active on the first page. */
  clicked: boolean
  /** Embeds of the remembered service on the paired page, and how many of them are active. */
  same: number
  sameActive: number
  /** Embeds of other services on the paired page, and how many of them are active (must be 0). */
  other: number
  otherActive: number
  banner: boolean
}

/** Remembering service S grants S only: every S embed loads, nothing else does, no banner. */
export const rememberOk = (c: RememberCounts): boolean => c.clicked && c.same > 0 && c.sameActive === c.same && c.otherActive === 0 && !c.banner

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

/** Loads the first embed of `service` with a one-off Visa and returns its iframe's computed filter, or null when the page has none. */
async function filterOf(page: Page, service: ServiceSlug): Promise<string | null> {
  const embed = page.locator(`[data-consent-embed="${service}"]`).first()
  if (!(await embed.count())) return null
  await embed.scrollIntoViewIfNeeded()
  await embed.locator('[data-load]').click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(1000)
  const iframe = embed.locator('iframe').first()
  return (await iframe.count()) ? await iframe.evaluate((f) => getComputedStyle(f).filter) : 'none'
}

/**
 * The one-off Visa check on the first embed, then (only after its reload measurement, so it never
 * touches what that check asserts) the filter reading for `filterService` when the first embed is of
 * another service.
 */
async function visaOnlyClicked(browser: Browser, base: string, path: string, stub: boolean, notes: string[], filterService: ServiceSlug | null) {
  const { context, page } = await freshPage(browser, stub)
  try {
    const hits = recordBlocked(page)
    await open(page, base, path)
    const declined = await decline(page, notes, 'visa')
    const count = await embeds(page).count()
    if (count === 0) {
      notes.push('visa: no [data-consent-embed] on the page')
      if (filterService) notes.push(`filter: no ${filterService} embed on the page`)
      return { ok: false, filter: 'none', openHref: null, filterKept: null }
    }
    const first = embeds(page).first()
    const service = await first.getAttribute('data-consent-embed')
    // A script widget (ConsentWidget) has no "Öppna i" link: don't wait for one.
    const link = first.locator('a[data-open]')
    const openHref = (await link.count()) ? await link.first().getAttribute('href') : null
    await first.scrollIntoViewIfNeeded()
    const before = hits.length
    await first.locator('[data-load]').click()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(1000)
    // data-active is the loaded signal for both kinds. A widget ([data-script]) is filled by its
    // provider's script, which may or may not add iframes of its own: its iframe count is not asserted.
    const clicked = (await first.getAttribute('data-active')) !== null
    const widget = (await first.getAttribute('data-script')) !== null
    const own = await first.locator('iframe').count()
    const total = await active(page).count()
    const filter = own && !widget ? await first.locator('iframe').first().evaluate((f) => getComputedStyle(f).filter) : 'none'
    const foreign = hits.slice(before).filter((u) => matchesRegistry(u) !== service)
    const afterClick = hits.length
    // One-off: a reload must show no embed and request nothing from the registry.
    await open(page, base, path)
    const reloaded = (await active(page).count()) + (await iframes(page).count())
    const afterReload = hits.length - afterClick
    const ok = declined && before === 0 && clicked && (widget || own === 1) && total === 1 && foreign.length === 0 && reloaded === 0 && afterReload === 0
    if (!ok) {
      notes.push(
        `visa: before click blocked=${before}; clicked ${service} data-active=${clicked} iframe=${own}, active on page=${total} of ${count} embeds; ` +
          `other services=${JSON.stringify(foreign.slice(0, 3))}; after reload active+iframes=${reloaded} blocked=${afterReload}`,
      )
    }
    if (!filterService) return { ok, filter, openHref, filterKept: null }
    if (service === filterService) return { ok, filter, openHref, filterKept: filter !== 'none' }
    const other = await filterOf(page, filterService)
    if (other === null) {
      notes.push(`filter: no ${filterService} embed on the page`)
      return { ok, filter, openHref, filterKept: null }
    }
    return { ok, filter: other, openHref, filterKept: other !== 'none' }
  } finally {
    await context.close()
  }
}

async function rememberCarries(browser: Browser, base: string, a: string, candidates: string[], stub: boolean, notes: string[]) {
  const { context, page } = await freshPage(browser, stub)
  try {
    await open(page, base, a)
    if (!(await decline(page, notes, 'remember'))) return false
    const first = embeds(page).first()
    if (!(await first.count())) return false
    const service = (await first.getAttribute('data-consent-embed')) ?? ''
    await first.scrollIntoViewIfNeeded()
    await first.locator('[data-remember]').check()
    await first.locator('[data-load]').click()
    await page.waitForTimeout(1000)
    const clicked = (await first.getAttribute('data-active')) !== null
    // Remembering S grants S only, so the pair is the next page that has an S embed (a reload of
    // `a` when none does). Pages without S are only looked at, never asserted.
    const same = page.locator(`[data-consent-embed="${service}"]`)
    let b = a
    for (const p of candidates) {
      await open(page, base, p)
      if (await same.count()) {
        b = p
        break
      }
    }
    if (b === a && candidates.length > 1) notes.push(`remember ${service}: no other page has it, checked a reload of ${a}`)
    const c = {
      clicked,
      same: await same.count(),
      sameActive: await page.locator(`[data-consent-embed="${service}"][data-active]`).count(),
      other: (await embeds(page).count()) - (await same.count()),
      otherActive: (await active(page).count()) - (await page.locator(`[data-consent-embed="${service}"][data-active]`).count()),
      banner: (await bannerState(page)).open,
    }
    const ok = rememberOk(c)
    if (!ok) {
      notes.push(
        `remember ${service}: ${a} active=${c.clicked}; ${b} ${service} active=${c.sameActive}/${c.same}, ` +
          `other services active=${c.otherActive}/${c.other} banner=${c.banner}`,
      )
    }
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
    const loaded = (await iframes(page).count()) + (await active(page).count())
    const banner = (await bannerState(page)).open
    const ok = declined && hits.length === 0 && loaded === 0 && !banner
    if (!ok) notes.push(`neka: declined=${declined} blocked=${hits.length} iframes+active=${loaded} banner=${banner}`)
    return ok
  } finally {
    await context.close()
  }
}

/**
 * Runs the three consent paths on each embed page, each in a fresh context. `stub` (default true)
 * fulfils registry requests locally, so clicking "Visa" never reaches Google; pass false on live
 * runs. `expectFilter(path)` names the service whose iframe had a CSS filter that wire carried over
 * (null: none expected).
 */
export async function checkConsentPaths(
  browser: Browser,
  base: string,
  mapPaths: string[],
  opts: { stub?: boolean; expectFilter?: (path: string) => ServiceSlug | null } = {},
): Promise<ConsentPathResult[]> {
  const stub = opts.stub ?? true
  const results: ConsentPathResult[] = []
  for (const [i, path] of mapPaths.entries()) {
    const notes: string[] = []
    const visa = await visaOnlyClicked(browser, base, path, stub, notes, opts.expectFilter?.(path) ?? null)
    const rememberAutoShows = await rememberCarries(browser, base, path, rememberCandidates(mapPaths, i), stub, notes)
    const nekaLoadsNothing = await nekaNothing(browser, base, path, stub, notes)
    const filterKept = visa.filterKept
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
