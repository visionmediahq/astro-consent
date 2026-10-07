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

/** A fresh context (empty storage), stubbed when `stub`. Close it with context.close(). */
export async function freshPage(
  browser: Browser,
  stub: boolean,
  viewport?: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: 'sv-SE', ...(viewport ? { viewport } : {}) })
  if (stub) await stubContext(context)
  return { context, page: await context.newPage() }
}

/** Opens base + path and lets lazy content load: scrolled to the end, then a short wait (as the pilot). */
export async function open(page: Page, base: string, path: string): Promise<void> {
  await page.goto(base + path, GOTO)
  await page.mouse.wheel(0, 20000)
  await page.waitForTimeout(1500)
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
  banner: boolean
  /** Registry requests made before any consent click. Must be empty on the branch. */
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
      const banner = await page.locator('[data-consent-banner]').isVisible()
      const errors = all.filter((e) => !baseline.has(e))
      const known = all.filter((e) => baseline.has(e))
      results.push({
        path,
        banner,
        blocked: [...blocked],
        errors,
        known,
        ok: banner === expectBanner(path) && blocked.length === 0 && errors.length === 0,
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
    lines.push(`${r.path}: banner=${r.banner} blocked=${r.blocked.length} errors=${r.errors.length} (baseline ${r.known.length}) ${r.ok ? 'ok' : 'FAIL'}`)
    const hosts = new Map<string, string>()
    for (const h of r.blocked) {
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
