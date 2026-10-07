import { expect, test, type Locator } from '@playwright/test'
import { parseColour, wcagContrast } from '../../ci/rollout/lib/colour'
import { action, stub } from './helpers'

// Transitions off: DaisyUI buttons animate colour changes, and we read the settled value.
const withPrimary = (hex: string) =>
  `:root { --color-primary: ${hex} } * { transition: none !important }`
const RED = withPrimary('#ff0000')
// Worst pool colour under the old lightness rule (4.43:1 with white text): black must win.
const GREEN = withPrimary('#538264')

async function colours(button: Locator): Promise<{ fg: string; bg: string; fgAlpha: number }> {
  return button.evaluate((el) => {
    const style = getComputedStyle(el)
    // Chromium serialises relative colours as oklch()/oklab(): rasterise each to read plain sRGB.
    const rasterise = (css: string): Uint8ClampedArray => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      return ctx.getImageData(0, 0, 1, 1).data
    }
    const toRgb = (css: string): string => {
      const [r, g, b] = rasterise(css)
      return `rgb(${r}, ${g}, ${b})`
    }
    return { fg: toRgb(style.color), bg: toRgb(style.backgroundColor), fgAlpha: rasterise(style.color)[3]! }
  })
}

async function expectAa(button: Locator, text: 'black' | 'white' = 'black'): Promise<void> {
  const { fg, bg } = await colours(button)
  const v = text === 'black' ? 0 : 255
  expect(parseColour(fg), `fg ${fg}`).toEqual({ r: v, g: v, b: v })
  expect(wcagContrast(parseColour(fg), parseColour(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
}

test('banner buttons are AA on a red primary', async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  await page.addStyleTag({ content: RED })
  for (const name of ['none', 'all']) await expectAa(action(page, name))
})

test('embed Visa button is AA on a red primary', async ({ page, context }) => {
  await stub(context)
  await page.goto('/karta')
  await page.addStyleTag({ content: RED })
  const buttons = page.locator('[data-consent-embed] [data-load]')
  expect(await buttons.count()).toBeGreaterThan(0)
  for (const button of await buttons.all()) await expectAa(button)
})

test('banner buttons are AA on a mid green primary', async ({ page, context }) => {
  await stub(context)
  await page.goto('/')
  await page.addStyleTag({ content: GREEN })
  for (const name of ['none', 'all']) await expectAa(action(page, name))
})

// Out-of-gamut oklch primaries (daisyUI 5 sites mostly write oklch). Relative colour does no gamut
// mapping, so a channel can be negative; the rule must clamp it. Hex primaries never exercise this.
for (const [name, primary, text] of [
  ['fantasy', 'oklch(37.45% 0.189 325.02)', 'white'],
  ['winter', 'oklch(56.86% 0.255 257.57)', 'white'],
] as const) {
  test(`banner buttons are AA on the out-of-gamut ${name} primary`, async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await page.addStyleTag({ content: withPrimary(primary) })
    for (const n of ['none', 'all']) await expectAa(action(page, n), text)
  })
}

// A primary with alpha: relative colour copies the origin's alpha unless the rule says "/ 1", which
// would make the button text half transparent. Pick must still be the better of black and white.
for (const primary of ['#697d9594', 'oklch(30% 0.1 260 / 0.5)']) {
  test(`button text is opaque and the better colour on the translucent primary ${primary}`, async ({ page, context }) => {
    await stub(context)
    await page.goto('/')
    await page.addStyleTag({ content: withPrimary(primary) })
    for (const n of ['none', 'all']) {
      const { fg, bg, fgAlpha } = await colours(action(page, n))
      expect(fgAlpha, `text alpha of ${fg}`).toBe(255)
      const b = parseColour(bg)
      const best = wcagContrast({ r: 0, g: 0, b: 0 }, b) >= wcagContrast({ r: 255, g: 255, b: 255 }, b) ? 0 : 255
      expect(parseColour(fg), `fg ${fg} on ${bg}`).toEqual({ r: best, g: best, b: best })
    }
  })
}
