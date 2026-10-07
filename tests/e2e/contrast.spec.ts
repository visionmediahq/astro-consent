import { expect, test, type Locator } from '@playwright/test'
import { parseColour, wcagContrast } from '../../ci/rollout/lib/colour'
import { action, stub } from './helpers'

// Transitions off: DaisyUI buttons animate colour changes, and we read the settled value.
const withPrimary = (hex: string) =>
  `:root { --color-primary: ${hex} } * { transition: none !important }`
const RED = withPrimary('#ff0000')
// Worst pool colour under the old lightness rule (4.43:1 with white text): black must win.
const GREEN = withPrimary('#538264')

async function colours(button: Locator): Promise<{ fg: string; bg: string }> {
  return button.evaluate((el) => {
    const style = getComputedStyle(el)
    // Chromium serialises relative colours as oklch()/oklab(): rasterise each to read plain sRGB.
    const toRgb = (css: string): string => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return `rgb(${r}, ${g}, ${b})`
    }
    return { fg: toRgb(style.color), bg: toRgb(style.backgroundColor) }
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
