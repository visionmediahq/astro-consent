import { expect, test } from '@playwright/test'
import { seed, stored, stub } from './helpers'

// An embed inside a widget's slot is not in the document until the widget activates (#28).

test('a record granting both activates the outer widget and the embed inside it', async ({ page, context }) => {
  await stub(context)
  await seed(page, '/nastlad', { choice: 'custom', categories: ['necessary'], services: ['elfsight', 'google-calendar'] })
  await expect(page.locator('#yttre [data-rendered]')).toHaveCount(1)
  await expect(page.locator('#inre iframe')).toHaveAttribute('src', /calendar\.google\.com/)
})

test('a one-off Visa on the widget activates an inner embed the record grants', async ({ page, context }) => {
  await stub(context)
  const record = await seed(page, '/nastlad', { choice: 'custom', categories: ['necessary'], services: ['google-calendar'] })
  await expect(page.locator('#yttre [data-placeholder]')).toBeVisible()
  await page.locator('#yttre > [data-placeholder] [data-load]').click()
  await expect(page.locator('#yttre [data-rendered]')).toHaveCount(1)
  await expect(page.locator('#inre iframe')).toHaveAttribute('src', /calendar\.google\.com/)
  expect(await stored(page)).toEqual(record)
})

test('an inner embed the record does not grant stays a placeholder', async ({ page, context }) => {
  const stubs = await stub(context)
  await seed(page, '/nastlad', { choice: 'custom', categories: ['necessary'], services: ['elfsight'] })
  await expect(page.locator('#yttre [data-rendered]')).toHaveCount(1)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#inre [data-placeholder]')).toBeVisible()
  expect(stubs.registry.filter((url) => url.includes('calendar.google.com'))).toEqual([])
})
