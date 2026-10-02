import { expect, test } from '@playwright/test'
import {
  NOTICE,
  action,
  banner,
  captureEvents,
  captureUmami,
  events,
  seed,
  stored,
  storedRaw,
  stub,
  toggle,
  umamiCalls,
} from './helpers'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test.describe('notice mode', () => {
  test('shows only OK', async ({ page, context }) => {
    await stub(context)
    await page.goto(NOTICE)
    await expect(banner(page)).toBeVisible()
    await expect(banner(page).locator('[data-consent-action]')).toHaveCount(1)
    await expect(action(page, 'notice_ok')).toBeVisible()
  })

  test('OK stores choice notice_ok and the banner stays hidden after reload', async ({ page, context }) => {
    await stub(context)
    await page.goto(NOTICE)
    await action(page, 'notice_ok').click()
    await expect(banner(page)).toBeHidden()
    const record = await stored(page)
    expect(record?.choice).toBe('notice_ok')
    expect(record?.categories).toEqual(['necessary'])
    await page.reload()
    await expect(banner(page)).toBeHidden()
  })

  test('OK fires umami consent notice_ok', async ({ page, context }) => {
    await stub(context)
    await captureUmami(page)
    await page.goto(NOTICE)
    await action(page, 'notice_ok').click()
    expect(await umamiCalls(page)).toEqual([['consent', { choice: 'notice_ok' }]])
  })

  test('sendBeacon is not sent when logEndpoint is null', async ({ page, context }) => {
    const stubs = await stub(context)
    await page.goto(NOTICE)
    const beaconCalls = await page.evaluate(() => {
      let calls = 0
      const original = navigator.sendBeacon.bind(navigator)
      navigator.sendBeacon = (...args) => {
        calls++
        return original(...args)
      }
      ;(document.querySelector('[data-consent-action="notice_ok"]') as HTMLElement).click()
      return calls
    })
    expect(beaconCalls).toBe(0)
    expect(stubs.beacons).toEqual([])
  })

  test('openSettings in notice mode shows the notice again', async ({ page, context }) => {
    await stub(context)
    await page.goto(NOTICE)
    await action(page, 'notice_ok').click()
    await expect(banner(page)).toBeHidden()
    await page.locator('[data-consent-open]').click()
    await expect(banner(page)).toBeVisible()
    await expect(action(page, 'notice_ok')).toBeFocused()
  })
})

test.describe('consent mode', () => {
  test('no registry request before a choice on any demo page', async ({ page, context }) => {
    const stubs = await stub(context)
    for (const path of ['/', '/karta', '/skript', '/ssr', '/utan-banner']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      expect(stubs.registry, path).toEqual([])
      if (path !== '/utan-banner') await expect(banner(page), path).toBeVisible()
    }
  })

  test('the banner does not take focus on load', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await expect(banner(page)).toBeVisible()
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  })

  test('Neka and Acceptera alla are equally prominent', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    const decline = action(page, 'none')
    const accept = action(page, 'all')
    const [declineBox, acceptBox] = [await decline.boundingBox(), await accept.boundingBox()]
    expect(declineBox!.height).toBe(acceptBox!.height)
    expect(declineBox!.y).toBe(acceptBox!.y)
    await expect(decline).toHaveClass(/\bbtn-sm\b/)
    await expect(accept).toHaveClass(/\bbtn-sm\b/)
    // Spec: "same size, same button class" — no colour weighting between the two.
    expect(await decline.getAttribute('class')).toBe(await accept.getAttribute('class'))
    const [declineStyle, acceptStyle] = await Promise.all(
      [decline, accept].map((button) =>
        button.evaluate((el) => {
          const style = getComputedStyle(el)
          return [style.backgroundColor, style.color, style.borderColor, style.fontWeight].join('|')
        }),
      ),
    )
    expect(declineStyle).toBe(acceptStyle)
    const sameParent = await page.evaluate(() => {
      const find = (name: string) => document.querySelector(`[data-consent-action="${name}"]`)!
      return find('none').parentElement === find('all').parentElement
    })
    expect(sameParent).toBe(true)
    await expect(banner(page).locator('input:checked:not([disabled])')).toHaveCount(0)
  })

  test('the banner is fixed and does not shift layout', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await expect(banner(page)).toBeVisible()
    expect(await banner(page).evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
    const before = await page.locator('main').boundingBox()
    await action(page, 'none').click()
    await expect(banner(page)).toBeHidden()
    expect(await page.locator('main').boundingBox()).toEqual(before)
  })

  test('Acceptera alla stores every category with choice all', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await action(page, 'all').click()
    await expect(banner(page)).toBeHidden()
    const record = await stored(page)
    expect(record?.choice).toBe('all')
    expect(record?.categories).toEqual(['necessary', 'external', 'statistics'])
    expect(record?.services).toEqual([])
  })

  test('Neka stores only necessary with choice none', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await action(page, 'none').click()
    await expect(banner(page)).toBeHidden()
    const record = await stored(page)
    expect(record?.choice).toBe('none')
    expect(record?.categories).toEqual(['necessary'])
  })

  test('Neka survives a reload and loads nothing', async ({ page, context }) => {
    const stubs = await stub(context)
    await page.goto('/karta')
    await action(page, 'none').click()
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(banner(page)).toBeHidden()
    expect(stubs.registry).toEqual([])
    await expect(page.locator('iframe')).toHaveCount(0)
  })

  test('the settings view lists only categories in use', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await action(page, 'settings').click()
    await expect(banner(page)).toHaveAttribute('data-view', 'settings')
    await expect(banner(page).locator('[data-consent-main]')).toBeHidden()
    const categories = await banner(page)
      .locator('[data-consent-category]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-consent-category')))
    expect(categories).toEqual(['necessary', 'external', 'statistics'])
    await expect(banner(page).locator('[data-consent-category="statistics"]')).toBeVisible()
  })

  test('Spara val with statistics only stores custom', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await action(page, 'settings').click()
    await toggle(page, 'statistics').check()
    await action(page, 'custom').click()
    await expect(banner(page)).toBeHidden()
    const record = await stored(page)
    expect(record?.choice).toBe('custom')
    expect(record?.categories).toEqual(['necessary', 'statistics'])
  })

  test('a choice survives a reload without re-saving', async ({ page, context }) => {
    await stub(context)
    await captureEvents(page)
    await page.goto('/')
    await action(page, 'all').click()
    const before = await storedRaw(page)
    await page.reload()
    await expect(banner(page)).toBeHidden()
    expect((await events(page)).map((event) => event.type)).toEqual(['vm:consent-ready'])
    expect(await storedRaw(page)).toBe(before)
  })

  test('the record id is kept across saves', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await action(page, 'all').click()
    const first = await stored(page)
    expect(first?.id).toMatch(UUID)
    await page.locator('[data-consent-open]').click()
    await toggle(page, 'external').uncheck()
    await action(page, 'custom').click()
    const second = await stored(page)
    expect(second?.categories).toEqual(['necessary', 'statistics'])
    expect(second?.id).toBe(first?.id)
  })

  test('PrivacyLinks reopens the settings view with the current toggles and moves focus into the banner', async ({ page, context }) => {
    await stub(context)
    await seed(page, '/', { choice: 'custom', categories: ['necessary', 'statistics'] })
    await expect(banner(page)).toBeHidden()
    await page.locator('[data-consent-open]').click()
    await expect(banner(page)).toBeVisible()
    await expect(banner(page)).toHaveAttribute('data-view', 'settings')
    await expect(toggle(page, 'statistics')).toBeChecked()
    await expect(toggle(page, 'external')).not.toBeChecked()
    await expect(toggle(page, 'necessary')).toBeChecked()
    const focusInBanner = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      const inside = !!active?.closest('[data-consent-banner]')
      return inside && active!.offsetParent !== null
    })
    expect(focusInBanner).toBe(true)
  })

  test('reopening after Tillbaka or a save starts on the right view', async ({ page, context }) => {
    await stub(context)
    await seed(page, '/', { choice: 'custom', categories: ['necessary', 'statistics'] })
    await page.locator('[data-consent-open]').click()
    await action(page, 'back').click()
    await expect(banner(page)).toHaveAttribute('data-view', 'main')
    await expect(action(page, 'all')).toBeVisible()
    await action(page, 'settings').click()
    await toggle(page, 'statistics').uncheck()
    await action(page, 'custom').click()
    await expect(banner(page)).toBeHidden()
    await page.locator('[data-consent-open]').click()
    await expect(banner(page)).toHaveAttribute('data-view', 'settings')
    await expect(toggle(page, 'statistics')).not.toBeChecked()
  })

  test('focus returns to the footer link after a save from a view it opened', async ({ page, context }) => {
    await stub(context)
    await seed(page, '/', { choice: 'custom', categories: ['necessary', 'statistics'] })
    const opener = page.locator('[data-consent-open]')
    await opener.click()
    await expect(banner(page)).toBeVisible()
    await action(page, 'custom').click()
    await expect(banner(page)).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('focus is not moved to the footer link when the banner was not opened from it', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await action(page, 'none').click()
    await expect(banner(page)).toBeHidden()
    await expect(page.locator('[data-consent-open]')).not.toBeFocused()
  })

  test('vm:consent-ready fires on every load with null or the record', async ({ page, context }) => {
    await stub(context)
    await captureEvents(page)
    await page.goto('/')
    expect(await events(page)).toEqual([{ type: 'vm:consent-ready', record: null }])
    await action(page, 'all').click()
    await page.reload()
    const afterReload = await events(page)
    expect(afterReload).toHaveLength(1)
    expect(afterReload[0]!.type).toBe('vm:consent-ready')
    expect(afterReload[0]!.record?.choice).toBe('all')
  })

  test('vm:consent-changed carries the record', async ({ page, context }) => {
    await stub(context)
    await captureEvents(page)
    await page.goto('/')
    await action(page, 'none').click()
    const changed = (await events(page)).filter((event) => event.type === 'vm:consent-changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]!.record).toEqual(await stored(page))
  })

  test('sendBeacon carries site, id and the choice', async ({ page, context }) => {
    const stubs = await stub(context)
    await page.goto('/')
    await action(page, 'all').click()
    await expect.poll(() => stubs.beacons.length).toBe(1)
    const record = await stored(page)
    expect(stubs.beacons[0]).toEqual({ site: 'demo.test', ...record })
    expect((stubs.beacons[0] as { id: string }).id).toMatch(UUID)
  })

  test('banner asks again after the version changes', async ({ page, context }) => {
    const stubs = await stub(context)
    await seed(page, '/karta', { version: '0:000000', categories: ['necessary', 'external', 'statistics'] })
    await page.waitForLoadState('networkidle')
    await expect(banner(page)).toBeVisible()
    expect(stubs.registry).toEqual([])
  })

  test('stale record is not written back', async ({ page, context }) => {
    await stub(context)
    await seed(page, '/', { version: '0:000000' })
    const raw = await storedRaw(page)
    expect(JSON.parse(raw!).version).toBe('0:000000')
    await page.reload()
    await expect(banner(page)).toBeVisible()
    expect(await storedRaw(page)).toBe(raw)
  })

  test('choice survives the page but not a reload when storage throws', async ({ page, context }) => {
    await stub(context)
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked')
        },
      })
    })
    await page.goto('/')
    await expect(banner(page)).toBeVisible()
    await action(page, 'all').click()
    await expect(banner(page)).toBeHidden()
    expect(await page.evaluate(() => window.__vmConsent!.hasConsent('external'))).toBe(true)
    await page.reload()
    await expect(banner(page)).toBeVisible()
  })

  test('the runtime installs on a page without the banner', async ({ page, context }) => {
    await stub(context)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await captureEvents(page)
    await page.goto('/utan-banner')
    expect(await page.evaluate(() => typeof window.__vmConsent?.hasConsent)).toBe('function')
    expect((await events(page)).map((event) => event.type)).toEqual(['vm:consent-ready'])
    expect(errors).toEqual([])
  })

  test('a throwing onConsent callback does not keep the banner open or block other callbacks', async ({ page, context }) => {
    await stub(context)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await page.evaluate(() => {
      window.__vmConsent!.onConsent('statistics', () => {
        throw new Error('boom from a site script')
      })
      window.__vmConsent!.onConsent('statistics', () => {
        document.body.dataset.secondRan = '1'
      })
    })
    await action(page, 'all').click()
    await expect(banner(page)).toBeHidden()
    await expect(page.locator('body')).toHaveAttribute('data-second-ran', '1')
    expect((await stored(page))?.choice).toBe('all')
    // The site's error is still reported, just not in the middle of the banner's work.
    await expect.poll(() => errors).toContain('boom from a site script')
  })

  test('a second copy of the client module reuses the singleton', async ({ page, context }) => {
    await stub(context)
    await captureEvents(page)
    await page.goto('/')
    const reused = await page.evaluate(async () => {
      const entry = performance
        .getEntriesByType('resource')
        .map((resource) => resource.name)
        .find((name) => /\/_astro\/client\.[^/]+\.js$/.test(name))
      if (!entry) throw new Error('client chunk not found among loaded resources')
      const before = window.__vmConsent
      await import(/* @vite-ignore */ `${entry}?again`)
      return window.__vmConsent === before
    })
    expect(reused).toBe(true)
    await action(page, 'all').click()
    const changed = (await events(page)).filter((event) => event.type === 'vm:consent-changed')
    expect(changed).toHaveLength(1)
  })
})
