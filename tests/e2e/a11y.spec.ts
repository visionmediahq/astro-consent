import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { NOTICE, action, banner, stub } from './helpers'

test('consent banner main view has no axe violations', async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  await expect(banner(page)).toBeVisible()
  const results = await new AxeBuilder({ page }).include('[data-consent-banner]').analyze()
  expect(results.violations).toEqual([])
})

test('settings view has no axe violations', async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  await action(page, 'settings').click()
  const results = await new AxeBuilder({ page }).include('[data-consent-banner]').analyze()
  expect(results.violations).toEqual([])
})

test('notice banner has no axe violations', async ({ page, context }) => {
  await stub(context)
  await page.goto(NOTICE)
  await expect(banner(page)).toBeVisible()
  const results = await new AxeBuilder({ page }).include('[data-consent-banner]').analyze()
  expect(results.violations).toEqual([])
})

test('embed placeholder has no axe violations', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  const results = await new AxeBuilder({ page }).include('[data-consent-embed]').analyze()
  expect(results.violations).toEqual([])
})

test('privacy links in the dark footer have no axe violations', async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  const results = await new AxeBuilder({ page }).include('footer').analyze()
  expect(results.violations).toEqual([])
})

test('the banner is keyboard operable in DOM order', async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  await expect(banner(page)).toBeVisible()
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el?.closest('[data-consent-banner]')) return null
      return el.dataset.consentAction ?? el.tagName.toLowerCase()
    })
  const order: string[] = []
  for (let i = 0; i < 12 && order.length < 4; i++) {
    await page.keyboard.press('Tab')
    const current = await focused()
    if (current) order.push(current)
  }
  // The consent demo has a policy_url, so the "Läs mer" link comes first.
  expect(order).toEqual(['a', 'settings', 'none', 'all'])
  await page.keyboard.press('Shift+Tab')
  expect(await focused()).toBe('none')
  await page.keyboard.press('Enter')
  await expect(banner(page)).toBeHidden()
})

test('the banner fits a 375 px wide, 600 px tall viewport', async ({ page, context }) => {
  await stub(context)
  await page.setViewportSize({ width: 375, height: 600 })
  await page.goto('/')
  await action(page, 'settings').click()
  const box = (await banner(page).boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(600)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  await action(page, 'custom').scrollIntoViewIfNeeded()
  await expect(action(page, 'custom')).toBeInViewport()
})
