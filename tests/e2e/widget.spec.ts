import { expect, test, type Page } from '@playwright/test'
import { action, countLoads, loads, seed, stored, stub } from './helpers'

const OK = 'https://elfsightcdn.com/platform.js'
const A = '#flode-a'
const B = '#flode-b'

const scriptTags = (page: Page) => page.locator(`head script[src="${OK}"]`)
const loadsOf = (page: Page) => page.evaluate(() => (window as unknown as { __elfsightLoads?: number }).__elfsightLoads ?? 0)

test('before consent: placeholders only, nothing requested', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/flode')
  await page.waitForLoadState('networkidle')
  expect(stubs.registry).toEqual([])
  await expect(page.locator(`${A} [data-load]`)).toHaveText('Visa Elfsight')
  await expect(page.locator(`${A} a[data-open]`)).toHaveCount(0)
  await expect(page.locator('#kalender a[data-open]')).toHaveAttribute(
    'href',
    /calendar\.google\.com\/calendar\/embed\?src=/,
  )
})

test('a one-off Visa activates only the clicked widget', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/flode')
  await page.locator(`${A} [data-load]`).click()
  await expect(page.locator(`${A} [data-rendered]`)).toHaveCount(1)
  await expect(page.locator(A)).toHaveAttribute('data-active', '')
  await expect(page.locator(`${B} [data-placeholder]`)).toBeVisible()
  await expect(page.locator('.elfsight-app-demo-b')).toHaveCount(0)
  await expect(scriptTags(page)).toHaveCount(1)
  await expect.poll(() => stubs.registry.length).toBeGreaterThan(0)
  for (const url of stubs.registry) expect(url).toContain('elfsight')
  expect(await stored(page)).toBeNull()
})

test('Visa on A then on B loads the script once', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  await page.locator(`${A} [data-load]`).click()
  await expect(page.locator(`${A} [data-rendered]`)).toHaveCount(1)
  await page.locator(`${B} [data-load]`).click()
  await expect(page.locator(`${B} [data-rendered]`)).toHaveCount(1)
  await expect(scriptTags(page)).toHaveCount(1)
  expect(await loadsOf(page)).toBe(1)
})

test('remembering on A grants the service to B but not to the calendar', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  await page.locator(`${A} [data-remember]`).check()
  await page.locator(`${A} [data-load]`).click()
  await expect(page.locator(`${A} [data-rendered]`)).toHaveCount(1)
  await expect(page.locator(`${B} [data-rendered]`)).toHaveCount(1)
  await expect(page.locator('#kalender iframe')).toHaveCount(0)
  expect((await stored(page))?.services).toEqual(['elfsight'])
})

test('Acceptera alla activates calendar and both widgets, script once', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  await action(page, 'all').click()
  await expect(page.locator('#kalender iframe')).toHaveAttribute('src', /calendar\.google\.com/)
  await expect(page.locator(`${A} [data-rendered]`)).toHaveCount(1)
  await expect(page.locator(`${B} [data-rendered]`)).toHaveCount(1)
  await expect(scriptTags(page)).toHaveCount(1)
})

test('adopting another tab\'s grant renders widgets without writing', async ({ context }) => {
  await stub(context)
  const [p, o] = [await context.newPage(), await context.newPage()]
  await p.addInitScript(() => {
    const original = Storage.prototype.setItem
    ;(window as unknown as { __writes: number }).__writes = 0
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'vm_consent') (window as unknown as { __writes: number }).__writes++
      return original.call(this, key, value)
    }
  })
  await p.goto('/flode')
  await o.goto('/flode')
  await action(o, 'all').click()
  await expect(p.locator(`${A} [data-rendered]`)).toHaveCount(1)
  await expect(p.locator(`${B} [data-rendered]`)).toHaveCount(1)
  expect(await p.evaluate(() => (window as unknown as { __writes: number }).__writes)).toBe(0)
})

test('a one-off calendar Visa leaves the widgets alone', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  await page.locator('#kalender [data-load]').click()
  await expect(page.locator('#kalender iframe')).toHaveAttribute('src', /calendar\.google\.com/)
  await expect(page.locator(`${A} [data-placeholder]`)).toBeVisible()
  await expect(page.locator(`${B} [data-placeholder]`)).toBeVisible()
  await expect(page.locator('.elfsight-app-demo-a')).toHaveCount(0)
  expect(await stored(page)).toBeNull()
})

test('withdrawing everything removes the widgets and requests nothing after the reload', async ({ page, context }) => {
  const stubs = await stub(context)
  await countLoads(page)
  await seed(page, '/flode', { choice: 'all', categories: ['necessary', 'external', 'statistics'] })
  await expect(page.locator('#kalender iframe')).toHaveCount(1)
  await expect(page.locator(`${A} [data-rendered]`)).toHaveCount(1)
  await expect(page.locator(`${B} [data-rendered]`)).toHaveCount(1)

  await page.locator('[data-consent-open]').click()
  await action(page, 'back').click()
  const before = stubs.registry.length
  const n = await loads(page)
  await action(page, 'none').click()
  await expect.poll(() => loads(page)).toBe(n + 1)
  await page.waitForLoadState('networkidle')
  expect(stubs.registry.length).toBe(before)
  await expect(scriptTags(page)).toHaveCount(0)
  await expect(page.locator(`${A} [data-placeholder]`)).toBeVisible()
  await expect(page.locator('#kalender [data-placeholder]')).toBeVisible()
})

test('a record without elfsight leaves the widgets as placeholders', async ({ page, context }) => {
  const stubs = await stub(context)
  await seed(page, '/flode', { choice: 'custom', categories: ['necessary'], services: ['google-calendar'] })
  await expect(page.locator('#kalender iframe')).toHaveCount(1)
  await page.waitForLoadState('networkidle')
  await expect(page.locator(`${A} [data-placeholder]`)).toBeVisible()
  expect(stubs.registry.filter((url) => url.includes('elfsight'))).toEqual([])
})
