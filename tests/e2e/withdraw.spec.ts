import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { action, banner, captureEvents, countLoads, events, loads, seed, stored, stub, toggle } from './helpers'

const COOKIES = ['_ga', '_ga_X', '_gid', '_fbp', 'keep']

async function addCookies(context: BrowserContext): Promise<void> {
  await context.addCookies(COOKIES.map((name) => ({ name, value: '1', domain: 'localhost', path: '/' })))
}

async function cookieNames(context: BrowserContext): Promise<string[]> {
  return (await context.cookies()).map((cookie) => cookie.name).sort()
}

/** Counts cookie-expiring writes made by this tab; the count survives reloads. Call before goto. */
async function countDeletes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get() {
        return descriptor.get!.call(this)
      },
      set(value: string) {
        if (value.includes('expires=Thu, 01 Jan 1970')) {
          sessionStorage.setItem('deletes', String(Number(sessionStorage.getItem('deletes') ?? '0') + 1))
        }
        descriptor.set!.call(this, value)
      },
    })
  })
}

const deletes = (page: Page) => page.evaluate(() => Number(sessionStorage.getItem('deletes') ?? '0'))
const gtag = (urls: string[]) => urls.filter((url) => url.includes('googletagmanager.com/gtag/js'))

async function withdrawStatistics(page: Page): Promise<void> {
  await page.locator('[data-consent-open]').click()
  await toggle(page, 'statistics').uncheck()
  await action(page, 'custom').click()
}

test('withdrawing an active category deletes its cookies and reloads once; nothing loads afterwards', async ({ page, context }) => {
  const stubs = await stub(context)
  await countLoads(page)
  await page.goto('/skript')
  await action(page, 'all').click()
  await expect.poll(() => gtag(stubs.registry).length).toBe(1)
  await addCookies(context)
  const before = await loads(page)

  await withdrawStatistics(page)
  await expect.poll(() => loads(page)).toBe(before + 1)
  await page.waitForLoadState('networkidle')

  expect(await cookieNames(context)).toEqual(['_fbp', 'keep'])
  expect(gtag(stubs.registry)).toHaveLength(1)
  expect((await stored(page))?.categories).toEqual(['necessary', 'external'])
  await expect(page.locator('body')).not.toHaveAttribute('data-gtag-loaded', '1')
  expect(await loads(page)).toBe(before + 1)
})

test('withdrawing something that is not active does not reload', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await captureEvents(page)
  await seed(page, '/', { choice: 'custom', categories: ['necessary', 'statistics'] })
  await addCookies(context)
  const before = await loads(page)

  await withdrawStatistics(page)
  await expect(banner(page)).toBeHidden()
  await expect.poll(async () => (await events(page)).some((event) => event.type === 'vm:consent-changed')).toBe(true)

  expect(await loads(page)).toBe(before)
  expect(await cookieNames(context)).toEqual([...COOKIES].sort())
  expect((await stored(page))?.categories).toEqual(['necessary'])
})

test('removing a remembered service row reloads and removes the map', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await page.goto('/karta')
  await page.locator('#with-href [data-remember]').check()
  await page.locator('#with-href [data-load]').click()
  await expect(page.locator('iframe')).toHaveCount(2)
  const before = await loads(page)

  await action(page, 'settings').click()
  await toggle(page, 'service:google-maps').uncheck()
  await action(page, 'custom').click()
  await expect.poll(() => loads(page)).toBe(before + 1)

  await expect(page.locator('iframe')).toHaveCount(0)
  const record = await stored(page)
  expect(record?.services).toEqual([])
  expect(record?.choice).toBe('custom')
})

test('withdrawal in tab A reloads tab B once and only A deletes cookies', async ({ context }) => {
  const stubs = await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  for (const page of [a, b]) {
    await countLoads(page)
    await countDeletes(page)
  }
  await seed(a, '/skript', { choice: 'custom', categories: ['necessary', 'statistics'] })
  await b.goto('/skript')
  await expect(a.locator('body')).toHaveAttribute('data-gtag-loaded', '1')
  await expect(b.locator('body')).toHaveAttribute('data-gtag-loaded', '1')
  await addCookies(context)
  const [beforeA, beforeB] = [await loads(a), await loads(b)]
  const gtagBefore = gtag(stubs.registry).length

  await withdrawStatistics(a)
  await expect.poll(() => loads(a)).toBe(beforeA + 1)
  await expect.poll(() => loads(b)).toBe(beforeB + 1)
  await a.waitForLoadState('networkidle')
  await b.waitForLoadState('networkidle')

  expect(await deletes(a)).toBeGreaterThan(0)
  expect(await deletes(b)).toBe(0)
  expect(await cookieNames(context)).toEqual(['_fbp', 'keep'])
  // No cascade: neither tab reloads again, and gtag is not requested again.
  expect(await loads(a)).toBe(beforeA + 1)
  expect(await loads(b)).toBe(beforeB + 1)
  expect(gtag(stubs.registry)).toHaveLength(gtagBefore)
  await expect(b.locator('body')).not.toHaveAttribute('data-gtag-loaded', '1')
})

test('withdrawing a target read through hasConsent reloads', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await seed(page, '/', { choice: 'custom', categories: ['necessary', 'statistics'] })
  // A site script that gates on hasConsent() instead of onConsent().
  expect(await page.evaluate(() => window.__vmConsent!.hasConsent('google-analytics'))).toBe(true)
  await addCookies(context)
  const before = await loads(page)

  await withdrawStatistics(page)
  await expect.poll(() => loads(page)).toBe(before + 1)
  expect(await cookieNames(context)).toEqual(['_fbp', 'keep'])
})
