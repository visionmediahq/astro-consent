// What a site's own CSS can do to the package's markup, and what the package must survive.
import { expect, test, type Locator } from '@playwright/test'
import { parseColour, wcagContrast } from '../../ci/rollout/lib/colour'
import { action, banner, stub } from './helpers'

/**
 * The colour of `property` on `el` as it is painted, and the background behind it: the element's
 * and its ancestors' backgrounds composited over white, then the colour itself over that. Canvas
 * does the compositing, so alpha and oklch()/oklab() serialisations come out as plain sRGB.
 */
async function painted(el: Locator, property: 'color' | 'border-top-color'): Promise<{ fg: string; bg: string }> {
  return el.evaluate((node, prop) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const read = (): string => {
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return `rgb(${r}, ${g}, ${b})`
    }
    const layers: string[] = []
    for (let at: Element | null = node; at; at = at.parentElement) layers.unshift(getComputedStyle(at).backgroundColor)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 1, 1)
    for (const layer of layers) {
      ctx.fillStyle = layer
      ctx.fillRect(0, 0, 1, 1)
    }
    const bg = read()
    ctx.fillStyle = getComputedStyle(node).getPropertyValue(prop)
    ctx.fillRect(0, 0, 1, 1)
    return { fg: read(), bg }
  }, property)
}

async function contrast(el: Locator, property: 'color' | 'border-top-color'): Promise<[number, string]> {
  const { fg, bg } = await painted(el, property)
  return [wcagContrast(parseColour(fg), parseColour(bg)), `${property} ${fg} on ${bg}`]
}

const noTransitions = '* { transition: none !important }'

test.describe('site styles', () => {
  // site 1241412221 (#64): a site's `a { color }` in @layer base gave the "Öppna i" link 3.34:1.
  // PrivacyLinks is left out on purpose: it follows the site's footer colour.
  test("the banner's and the placeholder's links keep AA contrast under a site's link colour", async ({ page, context }) => {
    await stub(context)
    await page.goto('/karta')
    await expect(banner(page)).toBeVisible()
    await page.addStyleTag({ content: `${noTransitions} @layer base { a { color: #c8c8c8 } }` })
    const embedLinks = page.locator('[data-consent-embed] a[data-open]')
    const bannerLinks = banner(page).locator('a')
    expect(await embedLinks.count()).toBeGreaterThan(0)
    expect(await bannerLinks.count()).toBeGreaterThan(0)
    for (const link of [...(await embedLinks.all()), ...(await bannerLinks.all())]) {
      const [ratio, what] = await contrast(link, 'color')
      expect(ratio, `${await link.textContent()}: ${what}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  // site 1277867824 (#64): a fixed mobile call bar at z-index 60 covered the banner's buttons. The banner
  // is z-99, not 100: client sites' skip link (site 1218869363, site 1369745148, site 1252079051, ...) is focus:z-[100] ahead
  // of it and must stay on top.
  test('a fixed site bar up to z-index 98 does not cover the banner', async ({ page, context }) => {
    await stub(context)
    await page.setViewportSize({ width: 360, height: 640 })
    await page.goto('/')
    await expect(banner(page)).toBeVisible()
    await page.evaluate(() => {
      const bar = document.createElement('a')
      bar.textContent = '000-000 00 00'
      bar.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;height:60vh;z-index:98;background:#ddd')
      document.body.append(bar)
    })
    for (const name of ['settings', 'none', 'all']) {
      const hit = await action(page, name).evaluate((button) => {
        const box = button.getBoundingClientRect()
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return top !== null && button.contains(top)
      })
      expect(hit, `${name} is the topmost element at its centre`).toBe(true)
    }
  })

  test("a client site's focused skip link at z-index 100 stays above the banner", async ({ page, context }) => {
    await stub(context)
    await page.setViewportSize({ width: 360, height: 640 })
    await page.goto('/')
    await expect(banner(page)).toBeVisible()
    // Ahead of the banner in the DOM, as in client sites' Base.astro; placed where the banner is.
    const hit = await page.evaluate(() => {
      const skip = document.createElement('a')
      skip.href = '#main'
      skip.textContent = 'Hoppa till innehåll'
      skip.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;height:60vh;z-index:100;background:#fff')
      document.body.prepend(skip)
      const box = document.querySelector('[data-consent-banner]')!.getBoundingClientRect()
      return document.elementFromPoint(box.left + box.width / 2, box.bottom - 8) === skip
    })
    expect(hit, 'the skip link is the topmost element over the banner').toBe(true)
  })
})

// WCAG 1.4.11 (#52): the boundary of a control needs 3:1 against what is behind it. DaisyUI's
// checkbox border is base-content at 20 % (about 1.8:1).
test.describe('control boundaries are 3:1', () => {
  test('the placeholder remember checkbox', async ({ page, context }) => {
    await stub(context)
    await page.goto('/karta')
    await page.addStyleTag({ content: noTransitions })
    const boxes = page.locator('[data-consent-embed] [data-remember]')
    expect(await boxes.count()).toBeGreaterThan(0)
    for (const box of await boxes.all()) {
      for (const checked of [false, true]) {
        await box.setChecked(checked)
        const [ratio, what] = await contrast(box, 'border-top-color')
        expect(ratio, `${checked ? 'checked' : 'unchecked'}: ${what}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  test('the widget remember checkbox', async ({ page, context }) => {
    await stub(context)
    await page.goto('/flode')
    await page.addStyleTag({ content: noTransitions })
    const [ratio, what] = await contrast(page.locator('#flode-a [data-remember]'), 'border-top-color')
    expect(ratio, what).toBeGreaterThanOrEqual(3)
  })

  // A checked toggle-primary paints its boundary in the primary colour. Pale primaries are common
  // in the pool (the buttons get black text for them): this one is about 1.6:1 on white.
  test('the banner settings toggles, unchecked and checked, on a pale primary', async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await page.addStyleTag({ content: `${noTransitions} :root { --color-primary: #f5c518 }` })
    await action(page, 'settings').click()
    // Service rows show only once granted; show them unticked to measure them too.
    await page.evaluate(() => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-consent-service]')) row.hidden = false
    })
    const toggles = banner(page).locator('form[data-consent-settings] input[type="checkbox"]:not(:disabled)')
    expect(await toggles.count()).toBeGreaterThan(2)
    // Checked, the ring is base-content at full strength, as DaisyUI's own uncoloured toggle has it.
    const { fg: baseContent } = await painted(banner(page), 'color')
    for (const toggle of await toggles.all()) {
      const name = await toggle.getAttribute('name')
      for (const checked of [false, true]) {
        await toggle.setChecked(checked)
        const [ratio, what] = await contrast(toggle, 'border-top-color')
        expect(ratio, `${name} ${checked ? 'checked' : 'unchecked'}: ${what}`).toBeGreaterThanOrEqual(3)
        if (checked) expect((await painted(toggle, 'border-top-color')).fg, `${name} checked ring`).toBe(baseContent)
      }
    }
  })
})
