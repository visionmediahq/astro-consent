import { expect, test } from '@playwright/test'
import { banner, stub } from './helpers'

test('without JavaScript: banner stays hidden, placeholders and open links render, nothing is requested', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: 'http://localhost:4321' })
  const stubs = await stub(context)
  const page = await context.newPage()
  await page.goto('/karta')
  await page.waitForLoadState('networkidle')
  await expect(banner(page)).toBeHidden()
  await expect(page.locator('#with-href [data-placeholder]')).toBeVisible()
  await expect(page.locator('#with-href a[data-open]')).toHaveAttribute(
    'href',
    'https://www.google.com/maps/search/?api=1&query=demo',
  )
  await expect(page.locator('#no-href a[data-open]')).toHaveAttribute('href', 'https://maps.google.com/maps?q=demo')
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(stubs.registry).toEqual([])
  await context.close()
})
