import { expect, test } from '@playwright/test'
import { NOTICE, banner, stub } from './helpers'

test('consent demo serves the banner element and installs the runtime', async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  await expect(banner(page)).toBeAttached()
  const services = await page.evaluate(() => window.__vmConsent?.config.services)
  expect(services).toEqual(['google-maps', 'google-analytics'])
})

test('notice demo serves the banner element and installs the runtime', async ({ page, context }) => {
  await stub(context)
  await page.goto(NOTICE)
  await expect(banner(page)).toBeAttached()
  expect(await page.evaluate(() => window.__vmConsent?.config.services)).toEqual([])
})

test('the runtime is installed on an SSR page too', async ({ page, context }) => {
  await stub(context)
  await page.goto('/skript')
  expect(await page.evaluate(() => typeof window.__vmConsent)).toBe('object')
})

test("the banner's classes are in the built CSS", async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  const css = await page.evaluate(async () => {
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    const sheets = await Promise.all(links.map((link) => fetch(link.href).then((response) => response.text())))
    const inline = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '')
    return [...sheets, ...inline].join('\n')
  })
  expect(css).toContain('card-actions')
})
