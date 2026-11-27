import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { measureContrast } from '../../ci/rollout/checks/contrast'
import { parseColour, wcagContrast } from '../../ci/rollout/lib/colour'
import { action, stub } from './helpers'

// #172: /video's first video has a poster, imported into the demo and optimised by astro:assets.
// The demo's image is pale on purpose: the hard case for the white text over it.
const poster = (page: Page) => page.locator('#video-watch [data-placeholder] img')

test('the poster is visible, decorative and the site’s own, and nothing is requested from the registry', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/video')
  await action(page, 'none').click()
  await expect(poster(page)).toBeVisible()
  await expect(poster(page)).toHaveAttribute('alt', '')
  const { src, width } = await poster(page).evaluate(async (img: HTMLImageElement) => {
    await img.decode()
    return { src: img.currentSrc, width: img.naturalWidth }
  })
  expect(width).toBeGreaterThan(0)
  expect(new URL(src).origin).toBe(new URL(page.url()).origin)
  expect(src).toMatch(/\/_astro\/poster\.[\w-]+\.webp$/)
  // It covers the box, behind the controls: the button still takes the click.
  const box = (await page.locator('#video-watch').boundingBox())!
  const img = (await poster(page).boundingBox())!
  expect(img.width).toBeCloseTo(box.width, 0)
  expect(img.height).toBeCloseTo(box.height, 0)
  await page.waitForLoadState('networkidle')
  expect(stubs.registry).toEqual([])
  await page.locator('#video-watch [data-load]').click()
  await expect(page.locator('#video-watch iframe')).toHaveCount(1)
  await expect(page.locator('#video-watch img')).toHaveCount(0)
})

test('the embeds without a poster keep the plain box', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  await expect(page.locator('#video-second img, #video-shorts img')).toHaveCount(0)
})

test('the rollout contrast check passes over the poster, at desktop and phone width', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  // Neka once, so the banner covers nothing; the placeholders stay.
  await action(page, 'none').click()
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/video')
    await page.addStyleTag({ content: '* { transition: none !important }' })
    await poster(page).scrollIntoViewIfNeeded()
    const rows = (await measureContrast(page)).filter((row) => row.kind === 'placeholder')
    expect(rows.length, `${width}px`).toBeGreaterThanOrEqual(3 * 4)
    for (const row of rows) expect(row.ok, `${width}px "${row.button}" ${row.ratio.toFixed(2)} ${row.indeterminate ?? ''}`).toBe(true)
  }
})

test('the poster text keeps AA over any image: white on the darkening over pure white', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  const { veil, texts } = await page.locator('#video-watch [data-placeholder]').evaluate((el) => {
    const rgba = (css: string) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return `rgb(${r}, ${g}, ${b})`
    }
    const parts = [el.querySelector(':scope > div:first-child')!, el.querySelector('label')!, el.querySelector('a[data-open]')!]
    // The darkening composited over white: the brightest an image under it can make it.
    return { veil: rgba(getComputedStyle(el).backgroundColor), texts: parts.map((p) => rgba(getComputedStyle(p).color)) }
  })
  for (const text of texts) {
    expect(text).toBe('rgb(255, 255, 255)')
    expect(wcagContrast(parseColour(text), parseColour(veil)), `${text} on ${veil}`).toBeGreaterThanOrEqual(4.5)
  }
})

test('the embed with a poster has no axe violations', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  const results = await new AxeBuilder({ page }).include('#video-watch').analyze()
  expect(results.violations).toEqual([])
})
