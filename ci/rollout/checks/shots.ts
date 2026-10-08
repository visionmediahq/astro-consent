// Screenshots for the PR (spec C3 step 7), ported from the pilot kit's shots.ts and shot404.ts.
// Per path and width: -open (banner), -settings (consent mode), -closed, -footer (PrivacyLinks),
// and on pages with embeds -placeholder-<n> for every embed and -map for the first one loaded.
// Pass the 404 path from listPages() among `paths` to get the 404 shot.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { freshPage } from './requests'

const slug = (p: string): string => p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'
const action = (page: Page, name: string) => page.locator(`[data-consent-banner] [data-consent-action="${name}"]`)

/** Returns the files written. `stub` (default true) keeps the map click off Google; false on live runs. */
export async function shots(
  browser: Browser,
  base: string,
  paths: string[],
  outDir: string,
  widths: number[] = [360, 1280],
  opts: { stub?: boolean } = {},
): Promise<string[]> {
  mkdirSync(outDir, { recursive: true })
  const files: string[] = []
  for (const path of paths) {
    for (const width of widths) {
      const { context, page } = await freshPage(browser, opts.stub ?? true, { width, height: 800 })
      const shot = async (name: string) => {
        const file = join(outDir, `${slug(path)}-${width}-${name}.png`)
        await page.screenshot({ path: file })
        files.push(file)
      }
      try {
        await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 })
        await page.waitForTimeout(500)
        await shot('open')
        if (await action(page, 'notice_ok').isVisible()) {
          await action(page, 'notice_ok').click()
        } else if (await action(page, 'settings').isVisible()) {
          await action(page, 'settings').click()
          await page.waitForTimeout(300)
          await shot('settings')
          await action(page, 'back').click()
          await action(page, 'none').click()
        }
        await page.waitForTimeout(300)
        await shot('closed')
        const links = page.locator('[data-privacy-links]').first()
        if (await links.count()) {
          await links.scrollIntoViewIfNeeded()
          await page.waitForTimeout(300)
          await shot('footer')
        }
        const embeds = page.locator('[data-consent-embed]')
        const count = await embeds.count()
        for (let i = 0; i < count; i++) {
          await embeds.nth(i).scrollIntoViewIfNeeded()
          await page.waitForTimeout(300)
          await shot(`placeholder-${i + 1}`)
        }
        if (count) {
          const first = embeds.first()
          await first.scrollIntoViewIfNeeded()
          await first.locator('[data-load]').click()
          await page.waitForTimeout(opts.stub ?? true ? 500 : 3000)
          await shot('map')
        }
      } finally {
        await context.close()
      }
    }
  }
  return files
}
