import { expect, test, type Page } from '@playwright/test'
import { action, banner, countLoads, loads, seed, stored, stub, toggle } from './helpers'

/** Counts localStorage/sessionStorage writes to vm_consent made by this page. */
async function countConsentWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    ;(window as unknown as { __consentWrites: number }).__consentWrites = 0
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'vm_consent') (window as unknown as { __consentWrites: number }).__consentWrites++
      return original.call(this, key, value)
    }
  })
}

const consentWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __consentWrites: number }).__consentWrites)

const choiceOf = (page: Page) => page.evaluate(() => window.__vmConsent!.record?.choice ?? null)

test('a choice in tab A hides the banner in tab B', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await a.goto('/')
  await b.goto('/')
  await expect(banner(b)).toBeVisible()
  await action(a, 'all').click()
  await expect(banner(b)).toBeHidden()
})

test('adopting a change from another tab writes nothing to storage', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await countConsentWrites(b)
  await a.goto('/')
  await b.goto('/')
  await action(a, 'all').click()
  await expect(banner(b)).toBeHidden()
  expect(await b.evaluate(() => window.__vmConsent!.hasConsent('external'))).toBe(true)
  expect(await consentWrites(b)).toBe(0)
})

test('Neka in tab A is adopted by tab B', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await a.goto('/')
  await b.goto('/')
  await action(a, 'none').click()
  await expect(banner(b)).toBeHidden()
  expect(await choiceOf(b)).toBe('none')
})

test('a cleared record in another tab shows the banner again', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await seed(a, '/', { categories: ['necessary', 'external'] })
  await countLoads(b)
  await b.goto('/')
  await expect(banner(b)).toBeHidden()
  await a.evaluate(() => localStorage.removeItem('vm_consent'))
  await expect(banner(b)).toBeVisible()
  expect(await choiceOf(b)).toBeNull()
  expect(await loads(b)).toBe(1)
})

test('localStorage.clear() in another tab shows the banner again', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await seed(a, '/')
  await b.goto('/')
  await expect(banner(b)).toBeHidden()
  await a.evaluate(() => localStorage.clear())
  await expect(banner(b)).toBeVisible()
})

test('a change in another tab does not close an open settings view', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await a.goto('/')
  await b.goto('/')
  await action(b, 'settings').click()
  await expect(banner(b)).toHaveAttribute('data-view', 'settings')
  await action(a, 'all').click()
  await expect.poll(() => choiceOf(b)).toBe('all')
  await expect(banner(b)).toBeVisible()
  await expect(banner(b)).toHaveAttribute('data-view', 'settings')
})

test('unrelated storage keys are ignored', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await seed(a, '/')
  await b.goto('/')
  await expect(banner(b)).toBeHidden()
  await a.evaluate(() => {
    localStorage.setItem('foo', 'bar')
    sessionStorage.setItem('vm_consent', 'not ours')
  })
  await a.evaluate(() => localStorage.setItem('ping', '1'))
  await expect(banner(b)).toBeHidden()
  expect(await choiceOf(b)).toBe('all')
})

test('an open settings view shows the choice another tab just made', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await a.goto('/')
  await b.goto('/')
  await action(b, 'settings').click()
  await expect(toggle(b, 'statistics')).not.toBeChecked()
  await action(a, 'all').click()
  await expect(toggle(b, 'statistics')).toBeChecked()
  await expect(toggle(b, 'external')).toBeChecked()
  await expect(banner(b)).toHaveAttribute('data-view', 'settings')
})

test('saving an open settings view does not re-grant what another tab withdrew', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await seed(a, '/', { choice: 'all', categories: ['necessary', 'external', 'statistics'] })
  await b.goto('/')
  await b.locator('[data-consent-open]').click()
  await expect(toggle(b, 'statistics')).toBeChecked()
  // Tab A already has a choice, so its banner is hidden: reopen it, go back to the main view, decline.
  await a.locator('[data-consent-open]').click()
  await action(a, 'back').click()
  await action(a, 'none').click()
  await expect(toggle(b, 'statistics')).not.toBeChecked()
  await expect(toggle(b, 'external')).not.toBeChecked()
  await action(b, 'custom').click()
  expect((await stored(b))?.categories).toEqual(['necessary'])
})

test('a change in another tab does not pull focus out of the page', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await seed(a, '/', { choice: 'all', categories: ['necessary', 'external', 'statistics'] })
  await b.goto('/')
  // In B the footer link opens the banner, the visitor goes back to the main view and then
  // moves on to something else on the page.
  await b.locator('[data-consent-open]').click()
  await action(b, 'back').click()
  const pageLink = b.locator('main a').first()
  await pageLink.focus()
  await expect(pageLink).toBeFocused()
  // A changes the choice; B adopts it and closes its banner.
  await a.locator('[data-consent-open]').click()
  await action(a, 'back').click()
  await action(a, 'none').click()
  await expect(banner(b)).toBeHidden()
  await expect(pageLink).toBeFocused()
  await expect(b.locator('[data-consent-open]')).not.toBeFocused()
})
