// Banner and request check (spec C3 step 3), ported from the pilot kit's check.ts. The blocked
// hosts are the registry patterns of src/services.ts, never a list of their own.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { matchesRegistry } from '../../../src/services'

/** The demo's log endpoint (demo/privacy.*.json). Stubbed with the registry in local runs. */
export const DEMO_LOG_HOST = 'log.demo.test'

const GOTO = { waitUntil: 'networkidle', timeout: 45_000 } as const

/** True for a URL that must not be requested before consent: it matches a registry pattern. */
export function isBlocked(url: string): boolean {
  return matchesRegistry(url) !== null
}

/**
 * Local runs: every registry request and every request to the demo log host is fulfilled here,
 * so nothing reaches Google, Meta or a log endpoint. Callers count requests with page.on('request'),
 * which sees stubbed requests too. Live runs don't call this.
 */
export async function stubContext(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => isBlocked(url.href) || url.hostname === DEMO_LOG_HOST,
    async (route) => {
      const request = route.request()
      if (new URL(request.url()).hostname === DEMO_LOG_HOST) return route.fulfill({ status: 204, body: '' })
      const isDocument = ['document', 'iframe'].includes(request.resourceType())
      await route.fulfill(
        isDocument
          ? { status: 200, contentType: 'text/html', body: '<html><body data-stub></body></html>' }
          : { status: 200, contentType: 'application/javascript', body: '/* stub */' },
      )
    },
  )
}

/**
 * A fresh context (empty storage), stubbed when `stub`. Close it with context.close().
 * Service workers are blocked: their fetches bypass context.route and the page's request events,
 * so a worker could load a registry host unseen.
 */
export async function freshPage(
  browser: Browser,
  stub: boolean,
  viewport?: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: 'sv-SE', serviceWorkers: 'block', ...(viewport ? { viewport } : {}) })
  if (stub) await stubContext(context)
  return { context, page: await context.newPage() }
}

/**
 * Opens base + path and lets lazy content load: scrolled to the end one viewport height at a time
 * (a single jump skips loaders that fire mid-page), back to the top, then a short wait.
 */
export async function open(page: Page, base: string, path: string): Promise<void> {
  await page.goto(base + path, GOTO)
  for (let i = 0; i < 60; i++) {
    const done = (await page.evaluate(
      '(() => { const y = scrollY; scrollBy(0, innerHeight); return scrollY === y || scrollY + innerHeight >= document.documentElement.scrollHeight })()',
    )) as boolean
    await page.waitForTimeout(150)
    if (done) break
  }
  await page.evaluate('scrollTo(0, 0)')
  await page.waitForTimeout(1500)
}

// Registry URLs can sit in the DOM without a request yet (data-src, loading="lazy" never scrolled
// to, a preconnect). Template content is not in the document, so ConsentEmbed's payload is skipped.
const DOM_URLS = `(() => {
  const out = []
  for (const e of document.querySelectorAll('iframe[src], iframe[data-src], script[src], link[href], img[src], source[src]')) {
    for (const a of ['src', 'data-src', 'href']) {
      const v = e.getAttribute(a)
      if (!v) continue
      try { out.push(new URL(v, location.href).href) } catch { out.push(v) }
    }
  }
  return out
})()`

/** Registry URLs found in the DOM that were never requested, as 'in DOM, not requested: <url>'. */
export function notRequested(domUrls: string[], requested: string[]): string[] {
  const seen = new Set(requested)
  return [...new Set(domUrls)].filter((u) => isBlocked(u) && !seen.has(u)).map((u) => `in DOM, not requested: ${u}`)
}

/** Registry URLs in the page's DOM that `requested` does not hold. */
export async function blockedInDom(page: Page, requested: string[]): Promise<string[]> {
  return notRequested((await page.evaluate(DOM_URLS)) as string[], requested)
}

export interface BannerState {
  /** Number of [data-consent-banner] elements. Anything but 1 is a problem. */
  count: number
  /** Exactly one banner, in the viewport, not transparent, and its Neka/OK button is on top. */
  shown: boolean
  /** Some banner is not hidden and has a box: the banner is not closed. */
  open: boolean
  problem?: string
}

const BANNER_STATE = `(() => {
  const all = [...document.querySelectorAll('[data-consent-banner]')]
  const boxed = (e) => { const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' }
  const state = { count: all.length, shown: false, open: all.some(boxed) }
  if (all.length !== 1) return { ...state, problem: all.length + ' banners' }
  const b = all[0]
  if (!boxed(b)) return { ...state, problem: 'hidden' }
  const r = b.getBoundingClientRect()
  if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return { ...state, problem: 'outside the viewport' }
  for (let e = b; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0) return { ...state, problem: 'opacity 0' }
  const btn = b.querySelector('[data-consent-action="none"], [data-consent-action="notice_ok"]')
  if (!btn) return { ...state, problem: 'no Neka/OK button' }
  const br = btn.getBoundingClientRect()
  const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2)
  if (!hit || !b.contains(hit)) return { ...state, problem: 'Neka/OK button covered or outside the viewport' }
  return { ...state, shown: true }
})()`

/** Whether the banner is really in front of the visitor, not just present in the DOM. */
export async function bannerState(page: Page): Promise<BannerState> {
  return (await page.evaluate(BANNER_STATE)) as BannerState
}

/** Records every registry request the page makes from now on. */
export function recordBlocked(page: Page): string[] {
  const hits: string[] = []
  page.on('request', (r) => {
    if (isBlocked(r.url())) hits.push(r.url())
  })
  return hits
}

export interface RequestResult {
  path: string
  /** The banner is shown (see BannerState.shown), not merely present. */
  banner: boolean
  /** Number of banners on the page; anything but 1 is reported in bannerProblem. */
  banners: number
  bannerProblem?: string
  /**
   * Registry requests made before any consent click, plus registry URLs in the DOM that were not
   * requested ('in DOM, not requested: …'). Must be empty on the branch.
   */
  blocked: string[]
  /** Console errors and page errors that are not in the baseline. */
  errors: string[]
  /** Console errors that are in the baseline (recorded on main): reported, not failing. */
  known: string[]
  /** banner === expectBanner(path), nothing blocked, no new errors. */
  ok: boolean
}

/**
 * Opens each path in a fresh context, never clicks anything, and reports whether the banner is
 * visible, which registry requests were made and which console errors appeared.
 * `stub: true` (local verify) fulfils registry and log-host requests locally: counted, never sent.
 * `stub: false` (live) blocks nothing and only counts.
 */
export async function checkRequests(
  browser: Browser,
  base: string,
  paths: string[],
  opts: { baseline?: Set<string>; stub: boolean; expectBanner?: (path: string) => boolean },
): Promise<RequestResult[]> {
  const baseline = opts.baseline ?? new Set<string>()
  const expectBanner = opts.expectBanner ?? (() => true)
  const results: RequestResult[] = []
  for (const path of paths) {
    const { context, page } = await freshPage(browser, opts.stub)
    try {
      const blocked = recordBlocked(page)
      const all: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') all.push(m.text())
      })
      page.on('pageerror', (e) => all.push(String(e)))
      await open(page, base, path)
      const state = await bannerState(page)
      const banner = state.shown
      blocked.push(...(await blockedInDom(page, blocked)))
      const errors = all.filter((e) => !baseline.has(e))
      const known = all.filter((e) => baseline.has(e))
      results.push({
        path,
        banner,
        banners: state.count,
        ...(state.problem && (expectBanner(path) || state.count > 1) ? { bannerProblem: state.problem } : {}),
        blocked: [...blocked],
        errors,
        known,
        ok: banner === expectBanner(path) && state.count <= 1 && blocked.length === 0 && errors.length === 0,
      })
    } finally {
      await context.close()
    }
  }
  return results
}

/** One line per result plus the distinct blocked URLs, as check.ts printed them. */
export function formatRequests(results: RequestResult[]): string[] {
  const lines: string[] = []
  for (const r of results) {
    lines.push(`${r.path}: banner=${r.banner}${r.bannerProblem ? ` (${r.bannerProblem})` : ''} blocked=${r.blocked.length} errors=${r.errors.length} (baseline ${r.known.length}) ${r.ok ? 'ok' : 'FAIL'}`)
    const hosts = new Map<string, string>()
    for (const h of r.blocked) {
      if (!/^https?:/.test(h)) {
        hosts.set(h, h)
        continue
      }
      const u = new URL(h)
      const key = u.host + u.pathname.split('/').slice(0, 3).join('/')
      if (!hosts.has(key)) hosts.set(key, h)
    }
    for (const h of hosts.values()) lines.push(`  BLOCKED ${h.slice(0, 160)}`)
    for (const e of r.errors) lines.push(`  ERROR ${e}`)
    for (const e of r.known) lines.push(`  baseline ${e}`)
  }
  return lines
}
