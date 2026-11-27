import { expect, test, type Page } from '@playwright/test'
import { action, banner, countLoads, loads, stored, stub, toggle } from './helpers'

// #170: a YouTube video gets the same consent flow as a map. The demo's /video page holds a watch
// URL with a start time, a Shorts URL and a youtu.be share link; /en/video is its English twin.
const embed = (page: Page, id: string) => page.locator(`#${id}`)
const show = (page: Page, id: string) => page.locator(`#${id} [data-load]`)
const remember = (page: Page, id: string) => page.locator(`#${id} [data-remember]`)
const VIDEOS = ['video-watch', 'video-shorts', 'video-second']
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; fullscreen'

test('the placeholders say what showing a video means, link to the watch page, and request nothing', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/video')
  await page.waitForLoadState('networkidle')
  const watch = embed(page, 'video-watch')
  await expect(show(page, 'video-watch')).toHaveText('Visa YouTube')
  await expect(remember(page, 'video-watch')).not.toBeChecked()
  await expect(watch.locator('label')).toContainText('Visa alltid innehåll från YouTube')
  await expect(watch.locator('[data-placeholder]')).toContainText(
    'Så tränar vi hämtas från YouTube. När du visar det skickas din IP-adress dit och cookies kan sättas.',
  )
  const open = watch.locator('a[data-open]')
  await expect(open).toHaveText('Öppna i YouTube')
  await expect(open).toHaveAttribute('href', 'https://www.youtube.com/watch?v=demoWatch01&t=90')
  await expect(embed(page, 'video-shorts').locator('a[data-open]')).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=demoShort01',
  )
  await expect(embed(page, 'video-second').locator('a[data-open]')).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=demoSecond1',
  )
  expect(stubs.registry).toEqual([])
  await expect(page.locator('iframe, [data-consent-embed] img')).toHaveCount(0)
})

test('Visa loads only that video from youtube-nocookie.com, with the allow list, and stores nothing', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/video')
  await show(page, 'video-watch').click()
  const iframe = embed(page, 'video-watch').locator('iframe')
  await expect(iframe).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/demoWatch01?start=90&autoplay=1')
  await expect(iframe).toHaveAttribute('allow', ALLOW)
  await expect(page.locator('iframe')).toHaveCount(1)
  await expect.poll(() => stubs.registry.length).toBe(1)
  expect(stubs.registry[0]).toContain('youtube-nocookie.com/embed/demoWatch01')
  expect(await stored(page)).toBeNull()
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(stubs.registry).toHaveLength(1)
})

test('Visa alltid stores a youtube grant and loads the other videos too', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/video')
  await remember(page, 'video-watch').check()
  await show(page, 'video-watch').click()
  for (const id of VIDEOS) await expect(embed(page, id).locator('iframe'), id).toHaveCount(1)
  const record = await stored(page)
  expect(record?.services).toEqual(['youtube'])
  expect(record?.categories).toEqual(['necessary'])
  await expect.poll(() => stubs.registry.length).toBe(3)
  expect(stubs.registry.every((url) => url.startsWith('https://www.youtube-nocookie.com/embed/'))).toBe(true)
  await page.reload()
  for (const id of VIDEOS) await expect(embed(page, id).locator('iframe'), id).toHaveCount(1)
})

test('Acceptera alla loads the videos without a reload', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await page.goto('/video')
  await action(page, 'all').click()
  for (const id of VIDEOS) await expect(embed(page, id).locator('iframe'), id).toHaveCount(1)
  expect(await loads(page)).toBe(1)
})

test('"Externt innehåll" loads the videos, and withdrawing it removes them', async ({ page, context }) => {
  const stubs = await stub(context)
  await countLoads(page)
  await page.goto('/video')
  await action(page, 'settings').click()
  await expect(banner(page).locator('[data-consent-service="youtube"]')).toBeHidden()
  await toggle(page, 'external').check()
  await action(page, 'custom').click()
  for (const id of VIDEOS) await expect(embed(page, id).locator('iframe'), id).toHaveCount(1)
  expect((await stored(page))?.categories).toEqual(['necessary', 'external'])

  await page.locator('[data-consent-open]').click()
  await toggle(page, 'external').uncheck()
  await action(page, 'custom').click()
  await expect.poll(() => loads(page)).toBe(2)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(stubs.registry).toHaveLength(3)
})

test('withdrawing a remembered youtube grant in the banner removes the videos', async ({ page, context }) => {
  await stub(context)
  await countLoads(page)
  await page.goto('/video')
  await remember(page, 'video-watch').check()
  await show(page, 'video-watch').click()
  await expect(page.locator('iframe')).toHaveCount(3)
  await action(page, 'settings').click()
  await expect(banner(page).locator('[data-consent-service="youtube"]')).toContainText('YouTube — visas alltid')
  await toggle(page, 'service:youtube').uncheck()
  await action(page, 'custom').click()
  await expect.poll(() => loads(page)).toBe(2)
  await expect(page.locator('iframe')).toHaveCount(0)
  expect((await stored(page))?.services).toEqual([])
})

test('a grant in tab A loads the videos in tab B without B writing vm_consent', async ({ context }) => {
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
  await a.goto('/video')
  await b.goto('/video')
  await remember(a, 'video-watch').check()
  await show(a, 'video-watch').click()
  for (const id of VIDEOS) await expect(embed(b, id).locator('iframe'), id).toHaveCount(1)
  expect(await b.evaluate(() => (window as unknown as { __writes: number }).__writes)).toBe(0)
})

test('the English page says "Show YouTube" and links to the watch page', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/en/video')
  const watch = embed(page, 'video-watch')
  await expect(show(page, 'video-watch')).toHaveText('Show YouTube')
  await expect(watch.locator('label')).toContainText('Always show content from YouTube')
  await expect(watch.locator('[data-placeholder]')).toContainText('How we train is fetched from YouTube')
  const open = watch.locator('a[data-open]')
  await expect(open).toHaveText('Open in YouTube')
  await expect(open).toHaveAttribute('href', 'https://www.youtube.com/watch?v=demoWatchEn&t=90')
  expect(stubs.registry).toEqual([])
  await show(page, 'video-watch').click()
  await expect(watch.locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/demoWatchEn?start=90&autoplay=1')
  await expect(page.locator('iframe')).toHaveCount(1)
  expect(await stored(page)).toBeNull()
})

test('the Shorts box is 9 / 16 (portrait) and the others 16 / 9, before and after Visa', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  // Width over height, the way CSS aspect-ratio writes it.
  const aspect = async (id: string) => {
    const box = (await embed(page, id).boundingBox())!
    return box.width / box.height
  }
  expect(await aspect('video-shorts')).toBeCloseTo(9 / 16, 1)
  expect(await aspect('video-watch')).toBeCloseTo(16 / 9, 1)
  await show(page, 'video-shorts').click()
  await expect(embed(page, 'video-shorts').locator('iframe')).toHaveCount(1)
  expect(await aspect('video-shorts')).toBeCloseTo(9 / 16, 1)
})

// #171: a click on "Visa" asks for the video, so it plays and focus moves into the player. Nothing
// else autoplays or moves focus: a stored grant, the banner, another tab, or the other videos that
// "Visa alltid" activates.
const iframe = (page: Page, id: string) => embed(page, id).locator('iframe')
const PLAYER = 'https://www.youtube-nocookie.com/embed/'

/** Every video on the page has loaded, none with autoplay, and focus is in none of them. */
async function loadedQuietly(page: Page): Promise<void> {
  for (const id of VIDEOS) {
    await expect(iframe(page, id), id).toHaveCount(1)
    expect(await iframe(page, id).getAttribute('src'), id).not.toContain('autoplay')
  }
  await expect(page.locator('iframe:focus')).toHaveCount(0)
}

test('Visa plays the clicked video and moves focus into it', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/video')
  await expect(embed(page, 'video-watch')).toHaveAttribute('data-autoplay', 'autoplay=1')
  await show(page, 'video-watch').click()
  await expect(iframe(page, 'video-watch')).toHaveAttribute('src', `${PLAYER}demoWatch01?start=90&autoplay=1`)
  await expect(iframe(page, 'video-watch')).toBeFocused()
  await expect.poll(() => stubs.registry).toEqual([`${PLAYER}demoWatch01?start=90&autoplay=1`])
  expect(await stored(page)).toBeNull()
})

test('Visa alltid plays only the clicked video; the others load silently and focus stays put', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  await remember(page, 'video-shorts').check()
  await show(page, 'video-shorts').click()
  await expect(iframe(page, 'video-shorts')).toHaveAttribute('src', `${PLAYER}demoShort01?autoplay=1`)
  for (const id of ['video-watch', 'video-second']) {
    await expect(iframe(page, id), id).toHaveCount(1)
    expect(await iframe(page, id).getAttribute('src'), id).not.toContain('autoplay')
  }
  await expect(iframe(page, 'video-shorts')).toBeFocused()
  expect((await stored(page))?.services).toEqual(['youtube'])
})

test('after a reload with a stored grant, the videos load without autoplay and focus does not move', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  await remember(page, 'video-watch').check()
  await show(page, 'video-watch').click()
  await expect(iframe(page, 'video-watch')).toBeFocused()
  await page.reload()
  await loadedQuietly(page)
})

test('the banner\'s all and external load the videos without autoplay and focus does not move', async ({ page, context }) => {
  await stub(context)
  await page.goto('/video')
  await action(page, 'all').click()
  await loadedQuietly(page)

  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await action(page, 'settings').click()
  await toggle(page, 'external').check()
  await action(page, 'custom').click()
  await loadedQuietly(page)
})

test('a grant from another tab loads the videos without autoplay and focus does not move', async ({ context }) => {
  await stub(context)
  const [a, b] = [await context.newPage(), await context.newPage()]
  await a.goto('/video')
  await b.goto('/video')
  await remember(a, 'video-watch').check()
  await show(a, 'video-watch').click()
  await expect(iframe(a, 'video-watch')).toHaveAttribute('src', `${PLAYER}demoWatch01?start=90&autoplay=1`)
  await loadedQuietly(b)
})
