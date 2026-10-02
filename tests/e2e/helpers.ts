import type { BrowserContext, Locator, Page } from '@playwright/test'
import { matchesRegistry } from '../../src/services'

/** Base URL of the notice-mode demo (no services). The consent demo is the default baseURL. */
export const NOTICE = 'http://localhost:4322'

export interface Stubs {
  /** Every request that matched a registry pattern. */
  registry: string[]
  /** Parsed bodies of beacons sent to the demo log endpoint. */
  beacons: unknown[]
}

/**
 * Routes every registry host and the demo log host to local stubs. Every test calls this first:
 * nothing may reach Google, Meta or a real log host.
 */
export async function stub(context: BrowserContext): Promise<Stubs> {
  const stubs: Stubs = { registry: [], beacons: [] }
  await context.route(
    (url) => matchesRegistry(url.href) !== null,
    async (route) => {
      stubs.registry.push(route.request().url())
      const isDocument = ['document', 'iframe'].includes(route.request().resourceType())
      await route.fulfill(
        isDocument
          ? { status: 200, contentType: 'text/html', body: '<html><body data-stub></body></html>' }
          : { status: 200, contentType: 'application/javascript', body: '/* stub */' },
      )
    },
  )
  await context.route('https://log.demo.test/**', async (route) => {
    stubs.beacons.push(JSON.parse(route.request().postData() ?? 'null'))
    await route.fulfill({ status: 204, body: '' })
  })
  return stubs
}

export function banner(page: Page): Locator {
  return page.locator('[data-consent-banner]')
}

export interface StoredRecord {
  id: string
  version: string
  saved_at: string
  choice: string | null
  categories: string[]
  services: string[]
}

/** The raw vm_consent value, or null. */
export function storedRaw(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('vm_consent'))
}

export async function stored(page: Page): Promise<StoredRecord | null> {
  const raw = await storedRaw(page)
  return raw ? (JSON.parse(raw) as StoredRecord) : null
}

/**
 * Opens `url`, writes a consent record ONCE with page.evaluate, and reloads.
 * Never uses addInitScript: that would re-seed on every later reload.
 */
export async function seed(page: Page, url: string, partial: Partial<StoredRecord> = {}): Promise<StoredRecord> {
  await page.goto(url)
  const record = await page.evaluate((overrides) => {
    const value = {
      id: 'seed-id',
      version: window.__vmConsent!.config.consentVersion,
      saved_at: new Date().toISOString(),
      choice: 'all',
      categories: ['necessary'],
      services: [],
      ...overrides,
    }
    localStorage.setItem('vm_consent', JSON.stringify(value))
    return value
  }, partial)
  await page.reload()
  return record as StoredRecord
}

export interface CapturedEvent {
  type: string
  record: StoredRecord | null
}

/** Records every vm:consent-* event of each page load into window.__events. Call before goto. */
export async function captureEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: unknown[] = []
    ;(window as unknown as { __events: unknown[] }).__events = events
    for (const type of ['vm:consent-ready', 'vm:consent-changed']) {
      window.addEventListener(type, (event) => {
        events.push({ type, record: (event as CustomEvent).detail.record })
      })
    }
  })
}

export function events(page: Page): Promise<CapturedEvent[]> {
  return page.evaluate(() => (window as unknown as { __events: CapturedEvent[] }).__events)
}

/** Installs a recording window.umami. Test-only: site code must never stub window.umami. */
export async function captureUmami(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: unknown[] = []
    ;(window as unknown as { __umami: unknown[] }).__umami = calls
    window.umami = { track: (name, data) => void calls.push([name, data]) }
  })
}

export function umamiCalls(page: Page): Promise<Array<[string, Record<string, unknown>]>> {
  return page.evaluate(() => (window as unknown as { __umami: Array<[string, Record<string, unknown>]> }).__umami)
}

/** Counts page loads of this tab in sessionStorage (survives reloads). Call before goto. */
export async function countLoads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') ?? '0') + 1))
  })
}

export function loads(page: Page): Promise<number> {
  return page.evaluate(() => Number(sessionStorage.getItem('loads') ?? '0'))
}

export function action(page: Page, name: string): Locator {
  return page.locator(`[data-consent-banner] [data-consent-action="${name}"]`)
}

export function toggle(page: Page, name: string): Locator {
  return page.locator(`[data-consent-banner] input[name="${name}"]`)
}
