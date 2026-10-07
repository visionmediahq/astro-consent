import { expect, test, type Page } from '@playwright/test'
import { action, banner, captureUmami, countLoads, loads, seed, stored, stub, toggle, umamiCalls } from './helpers'

const withHref = (page: Page) => page.locator('#with-href')
const noHref = (page: Page) => page.locator('#no-href')
const show = (page: Page, id: string) => page.locator(`#${id} [data-load]`)
const remember = (page: Page, id: string) => page.locator(`#${id} [data-remember]`)

test('placeholder shows the slot text, a Visa button, an unticked remember box and the given open link', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  await expect(withHref(page).locator('[data-placeholder]')).toContainText('Demogatan 1, 123 45 Demostad')
  await expect(show(page, 'with-href')).toHaveText('Visa Google Maps')
  await expect(remember(page, 'with-href')).not.toBeChecked()
  await expect(withHref(page).locator('label')).toContainText('Visa alltid innehåll från Google Maps')
  const open = withHref(page).locator('a[data-open]')
  await expect(open).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=demo')
  await expect(open).toHaveText('Öppna i Google Maps')
  await expect(noHref(page).locator('[data-placeholder]')).toContainText('Karta två hämtas från Google Maps.')
})

test('open link falls back to the de-embedded src', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  await expect(noHref(page).locator('a[data-open]')).toHaveAttribute('href', 'https://maps.google.com/maps?q=demo')
})

test('the placeholder requests nothing from the registry', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/karta')
  await page.waitForLoadState('networkidle')
  expect(stubs.registry).toEqual([])
  await expect(page.locator('link[rel="preconnect"], link[rel="dns-prefetch"]')).toHaveCount(0)
  await expect(page.locator('[data-consent-embed] img')).toHaveCount(0)
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('the placeholder is not clipped at 320 px wide', async ({ page, context }) => {
  await stub(context)
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/karta')
  await action(page, 'none').click()
  for (const id of ['with-href', 'no-href']) {
    const fits = await page.locator(`#${id}`).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)
    expect(fits, id).toBe(true)
    for (const selector of ['[data-load]', '[data-remember]', 'a[data-open]']) {
      const control = page.locator(`#${id} ${selector}`)
      await expect(control).toBeVisible()
      const box = (await control.boundingBox())!
      expect(box.x + box.width, `${id} ${selector}`).toBeLessThanOrEqual(320)
      const inside = await control.evaluate((el) => {
        const container = el.closest('[data-consent-embed]')!.getBoundingClientRect()
        const rect = el.getBoundingClientRect()
        return rect.bottom <= container.bottom + 1 && rect.top >= container.top - 1
      })
      expect(inside, `${id} ${selector} inside its box`).toBe(true)
    }
  }
})

test('Visa without the box loads only that embed, stores nothing, and the map is gone after reload', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/karta')
  await show(page, 'with-href').click()
  await expect(withHref(page).locator('iframe')).toHaveCount(1)
  await expect(withHref(page)).toHaveAttribute('data-active', '')
  await expect(withHref(page).locator('[data-placeholder]')).toHaveCount(0)
  await expect(noHref(page).locator('iframe')).toHaveCount(0)
  await expect.poll(() => stubs.registry.length).toBe(1)
  expect(stubs.registry[0]).toContain('pb=demo')
  expect(await stored(page)).toBeNull()
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(stubs.registry).toHaveLength(1)
})

test('a one-off Visa followed by Neka loads nothing else and does not reload', async ({ page, context }) => {
  const stubs = await stub(context)
  await countLoads(page)
  await page.goto('/karta')
  await show(page, 'with-href').click()
  await expect.poll(() => stubs.registry.length).toBe(1)
  await action(page, 'none').click()
  await expect(banner(page)).toBeHidden()
  await page.waitForLoadState('networkidle')
  expect(await loads(page)).toBe(1)
  await expect(withHref(page).locator('iframe')).toHaveCount(1)
  await expect(noHref(page).locator('iframe')).toHaveCount(0)
  expect(stubs.registry).toHaveLength(1)
  expect((await stored(page))?.choice).toBe('none')
})

test('a one-off Visa is not extended by a change in another tab', async ({ context }) => {
  const stubs = await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await a.goto('/')
  await b.goto('/karta')
  await show(b, 'with-href').click()
  await expect.poll(() => stubs.registry.length).toBe(1)
  await action(a, 'none').click()
  await expect(banner(b)).toBeHidden()
  await expect(withHref(b).locator('iframe')).toHaveCount(1)
  await expect(noHref(b).locator('iframe')).toHaveCount(0)
  expect(stubs.registry).toHaveLength(1)
})

test('embed grant keeps banner shown after reload', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  await remember(page, 'with-href').check()
  await show(page, 'with-href').click()
  const record = await stored(page)
  expect(record?.choice).toBeNull()
  expect(record?.services).toEqual(['google-maps'])
  expect(record?.categories).toEqual(['necessary'])
  await expect(banner(page)).toBeVisible()
  await page.reload()
  await expect(withHref(page).locator('iframe')).toHaveCount(1)
  await expect(noHref(page).locator('iframe')).toHaveCount(1)
  await expect(banner(page)).toBeVisible()
})

test('a remembered grant activates every embed of that service on the page', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  await remember(page, 'no-href').check()
  await show(page, 'no-href').click()
  await expect(withHref(page).locator('iframe')).toHaveCount(1)
  await expect(noHref(page).locator('iframe')).toHaveCount(1)
})

test('Acceptera alla loads the maps with no reload', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await page.goto('/karta')
  await action(page, 'all').click()
  await expect(withHref(page).locator('iframe')).toHaveCount(1)
  await expect(noHref(page).locator('iframe')).toHaveCount(1)
  expect(await loads(page)).toBe(1)
})

test('Neka after a remembered embed grant clears services and removes the map', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await page.goto('/karta')
  await remember(page, 'with-href').check()
  await show(page, 'with-href').click()
  await expect(page.locator('iframe')).toHaveCount(2)
  await action(page, 'none').click()
  await expect.poll(() => loads(page)).toBe(2)
  await expect(page.locator('iframe')).toHaveCount(0)
  const record = await stored(page)
  expect(record?.services).toEqual([])
  expect(record?.choice).toBe('none')
  await expect(banner(page)).toBeHidden()
})

test('Spara val keeps services and shows the service row', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  await remember(page, 'with-href').check()
  await show(page, 'with-href').click()
  await action(page, 'settings').click()
  const row = banner(page).locator('[data-consent-service="google-maps"]')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Google Maps — visas alltid')
  await expect(toggle(page, 'service:google-maps')).toBeChecked()
  await expect(banner(page).locator('[data-consent-service="google-analytics"]')).toBeHidden()
  await action(page, 'custom').click()
  const record = await stored(page)
  expect(record?.services).toEqual(['google-maps'])
  expect(record?.choice).toBe('custom')
  await expect(page.locator('iframe')).toHaveCount(2)
})

test('unticking a category while its service row stays ticked keeps the map without a reload', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await seed(page, '/karta', { choice: 'custom', categories: ['necessary', 'external'], services: ['google-maps'] })
  await expect(page.locator('iframe')).toHaveCount(2)
  const before = await loads(page)
  await page.locator('[data-consent-open]').click()
  await toggle(page, 'external').uncheck()
  await expect(toggle(page, 'service:google-maps')).toBeChecked()
  await action(page, 'custom').click()
  await expect(banner(page)).toBeHidden()
  const record = await stored(page)
  expect(record?.categories).toEqual(['necessary'])
  expect(record?.services).toEqual(['google-maps'])
  expect(await loads(page)).toBe(before)
  await expect(page.locator('iframe')).toHaveCount(2)
})

test('umami consent embed fires on a remembered grant only', async ({ page, context }) => {
  await stub(context)
  await captureUmami(page)
  await page.goto('/karta')
  await show(page, 'with-href').click()
  await expect(withHref(page).locator('iframe')).toHaveCount(1)
  expect(await umamiCalls(page)).toEqual([])
  await remember(page, 'no-href').check()
  await show(page, 'no-href').click()
  expect(await umamiCalls(page)).toEqual([['consent', { choice: 'embed' }]])
})

test('a grant in tab A activates the embed in tab B', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await b.addInitScript(() => {
    const original = Storage.prototype.setItem
    ;(window as unknown as { __writes: number }).__writes = 0
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'vm_consent') (window as unknown as { __writes: number }).__writes++
      return original.call(this, key, value)
    }
  })
  await a.goto('/karta')
  await b.goto('/karta')
  await action(a, 'all').click()
  await expect(b.locator('iframe')).toHaveCount(2)
  await expect(banner(b)).toBeHidden()
  expect(await b.evaluate(() => (window as unknown as { __writes: number }).__writes)).toBe(0)
})

test('the SSR page gates its embed too', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/ssr')
  await page.waitForLoadState('networkidle')
  expect(stubs.registry).toEqual([])
  await expect(page.locator('iframe')).toHaveCount(0)
  await action(page, 'all').click()
  await expect(page.locator('[data-consent-embed] iframe')).toHaveCount(1)
  await expect.poll(() => stubs.registry.some((url) => url.includes('pb=ssr'))).toBe(true)
})

test('a page without the banner still activates embeds from a stored grant', async ({ page, context }) => {
  await stub(context)
  await page.goto('/utan-banner')
  await page.locator('#bare [data-load]').click()
  await expect(page.locator('#bare iframe')).toHaveCount(1)
  expect(await stored(page)).toBeNull()
  await seed(page, '/', { categories: ['necessary', 'external'] })
  await page.goto('/utan-banner')
  await expect(page.locator('#bare iframe')).toHaveCount(1)
})

test('the Visa button is described by the placeholder info text, with a distinct id per embed', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  const buttons = page.locator('[data-load]')
  expect(await buttons.count()).toBeGreaterThanOrEqual(2)
  const targets = await buttons.evaluateAll((els) =>
    els.map((el) => {
      const id = el.getAttribute('aria-describedby')
      const target = id ? document.getElementById(id) : null
      return { id, text: target?.textContent ?? null, wrapsInfo: !!target && !!el.closest('[data-placeholder]')?.contains(target) }
    }),
  )
  for (const t of targets) {
    expect(t.id).toBeTruthy()
    expect(t.wrapsInfo).toBe(true)
  }
  expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length)
  await expect(page.locator('#no-href [data-load]')).toHaveAttribute('aria-describedby', /./)
  const descText = (id: string) =>
    page.locator(`#${id} [data-load]`).evaluate((el) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? '')
  expect(await descText('no-href')).toContain('Karta två')
  expect(await descText('with-href')).toContain('Demogatan 1, 123 45 Demostad')
})

test('the button label is the service name, not the iframe title', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  for (const id of ['with-href', 'no-href']) {
    await expect(show(page, id)).toHaveText('Visa Google Maps')
    await expect(show(page, id)).not.toContainText(id === 'no-href' ? 'Karta två' : 'Karta till oss')
  }
})
