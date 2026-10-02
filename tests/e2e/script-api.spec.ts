import { expect, test, type Page } from '@playwright/test'
import { action, banner, captureEvents, events, seed, stub, toggle } from './helpers'

const gtag = (urls: string[]) => urls.filter((url) => url.includes('googletagmanager.com/gtag/js'))

test('onConsent fires immediately when consent is already stored', async ({ page, context }) => {
  const stubs = await stub(context)
  await seed(page, '/skript', { categories: ['necessary', 'statistics'] })
  await expect(page.locator('body')).toHaveAttribute('data-gtag-loaded', '1')
  await expect.poll(() => gtag(stubs.registry).length).toBeGreaterThan(0)
})

test('onConsent fires once on a later grant', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/skript')
  await page.waitForLoadState('networkidle')
  expect(gtag(stubs.registry)).toHaveLength(0)
  await action(page, 'all').click()
  await expect(page.locator('body')).toHaveAttribute('data-gtag-loaded', '1')
  await expect.poll(() => gtag(stubs.registry).length).toBe(1)
  await page.locator('[data-consent-open]').click()
  await expect(toggle(page, 'statistics')).toBeChecked()
  await action(page, 'custom').click()
  await expect(banner(page)).toBeHidden()
  await page.waitForLoadState('networkidle')
  expect(gtag(stubs.registry)).toHaveLength(1)
  await expect(page.locator('head script[src*="googletagmanager"]')).toHaveCount(1)
})

test('onConsent does not fire after Neka', async ({ page, context }) => {
  const stubs = await stub(context)
  await captureEvents(page)
  await page.goto('/skript')
  await action(page, 'none').click()
  await expect.poll(async () => (await events(page)).some((event) => event.type === 'vm:consent-changed')).toBe(true)
  await page.waitForLoadState('networkidle')
  expect(stubs.registry).toEqual([])
  await expect(page.locator('body')).not.toHaveAttribute('data-gtag-loaded', '1')
})

test('hasConsent reflects the stored record', async ({ page, context }) => {
  await stub(context)
  await page.goto('/skript')
  expect(await page.evaluate(() => window.__vmConsent!.hasConsent('google-analytics'))).toBe(false)
  await action(page, 'all').click()
  expect(await page.evaluate(() => window.__vmConsent!.hasConsent('google-analytics'))).toBe(true)
  expect(await page.evaluate(() => window.__vmConsent!.hasConsent('marketing'))).toBe(false)
})

function collectWarnings(page: Page): string[] {
  const warnings: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[astro-consent]')) warnings.push(message.text())
  })
  return warnings
}

test('onConsent for a service the site has not listed warns once and never fires', async ({ page, context }) => {
  await stub(context)
  const warnings = collectWarnings(page)
  await page.goto('/')
  const granted = await page.evaluate(() => {
    const api = window.__vmConsent!
    api.onConsent('meta-pixel', () => {
      document.body.dataset.metaRan = '1'
    })
    api.onConsent('meta-pixel', () => {})
    return api.hasConsent('meta-pixel')
  })
  expect(granted).toBe(false)
  await action(page, 'all').click()
  await expect(banner(page)).toBeHidden()
  await expect(page.locator('body')).not.toHaveAttribute('data-meta-ran', '1')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('meta-pixel')
  expect(warnings[0]).toContain('privacy.json')
})

test('a category the site does not use warns too', async ({ page, context }) => {
  await stub(context)
  const warnings = collectWarnings(page)
  await page.goto('/')
  await page.evaluate(() => window.__vmConsent!.onConsent('marketing', () => {}))
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('marketing')
})

test('an unknown target is refused without throwing', async ({ page, context }) => {
  await stub(context)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const warnings = collectWarnings(page)
  await page.goto('/')
  const result = await page.evaluate(() => {
    const api = window.__vmConsent! as unknown as {
      hasConsent(target: string): boolean
      onConsent(target: string, fn: () => void): void
    }
    api.onConsent('nonsense', () => {
      document.body.dataset.nonsenseRan = '1'
    })
    return api.hasConsent('nonsense')
  })
  expect(result).toBe(false)
  await action(page, 'all').click()
  await expect(banner(page)).toBeHidden()
  await expect(page.locator('body')).not.toHaveAttribute('data-nonsense-ran', '1')
  expect(errors).toEqual([])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('nonsense')
})

test('targets the site has listed do not warn', async ({ page, context }) => {
  await stub(context)
  const warnings = collectWarnings(page)
  await page.goto('/skript')
  await page.evaluate(() => {
    window.__vmConsent!.hasConsent('external')
    window.__vmConsent!.hasConsent('google-maps')
    window.__vmConsent!.hasConsent('necessary')
  })
  await action(page, 'all').click()
  await expect(page.locator('body')).toHaveAttribute('data-gtag-loaded', '1')
  expect(warnings).toEqual([])
})
