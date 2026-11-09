// site 1249159919: the site's fixed mobile call bar (z-50, later in the DOM) sat on top of the banner
// and hid its OK button, and step 5 passed because it only measured widths. A banner button that
// another element covers is now reported.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, expect, test } from '@playwright/test'
import { checkClip } from '../../ci/rollout/checks/clip'

const banner = `<div data-consent-banner style="position:fixed;left:16px;right:16px;bottom:16px;z-index:50;background:#fff;padding:12px">
  <div class="card-body"><p>Så mäter vi besök</p><button style="width:80px;height:44px">OK</button></div></div>`
const PAGES: Record<string, string> = {
  // The bar comes after the banner with the same z-index, so it paints on top of the button.
  '/covered': `${banner}<a style="position:fixed;left:0;right:0;bottom:0;z-index:50;height:56px;background:#ddd">000-000 00 00</a>`,
  // A bar that is there but lower than the banner.
  '/below': `${banner}<a style="position:fixed;left:0;right:0;bottom:0;z-index:10;height:56px;background:#ddd">000-000 00 00</a>`,
  // The button's own text in a span: hitting a child of the button is the button.
  '/child': banner.replace('>OK<', '><span>OK</span><'),
  // Review of #140: a covered "Inställningar" made step 5 throw (Playwright's click waits 30 s for
  // the hit test). It must be reported as covered, and the settings view still measured.
  '/settings-covered': `<div data-consent-banner style="position:fixed;left:16px;right:16px;bottom:16px;z-index:50;background:#fff;padding:12px">
    <div class="card-body"><button data-consent-action="settings" onclick="document.querySelector('[data-consent-settings]').hidden=false" style="width:120px;height:44px">Inställningar</button>
    <form data-consent-settings hidden><div data-consent-category="external"><input type="checkbox" class="toggle" style="appearance:none;width:33px;height:20px;border:1px solid #000"></div></form></div></div>
    <a style="position:fixed;left:0;right:0;bottom:0;z-index:60;height:200px;background:#ddd">000-000 00 00</a>`,
}

let site: Server
let base = ''

test.beforeAll(async () => {
  site = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="sv"><head><title>Exempel</title></head><body style="margin:0">${PAGES[req.url ?? ''] ?? ''}</body></html>`)
  })
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', () => done()))
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
})

test.afterAll(() => site.close())

test('a covered "Inställningar" is reported as covered, and the settings view is still measured', async () => {
  test.setTimeout(60_000)
  const browser = await chromium.launch()
  try {
    const started = Date.now()
    const rows = await checkClip(browser, base, ['/settings-covered'], [360], { stub: true })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(rows.filter((r) => r.kind === 'button').map((r) => [r.button, r.covered])).toEqual([['Inställningar', true]])
    expect(rows.filter((r) => r.kind === 'control').map((r) => [r.button, r.clipped])).toEqual([['toggle external', false]])
  } finally {
    await browser.close()
  }
})

test('step 5 reports a banner button that another element covers, and only that', async () => {
  test.setTimeout(90_000)
  const browser = await chromium.launch()
  try {
    const rows = await checkClip(browser, base, ['/covered', '/below', '/child'], [360], { stub: true })
    const buttons = rows.filter((r) => r.kind === 'button')
    expect(buttons.map((r) => [r.path, r.button, r.covered, r.clipped])).toEqual([
      ['/covered', 'OK', true, true],
      ['/below', 'OK', false, false],
      ['/child', 'OK', false, false],
    ])
  } finally {
    await browser.close()
  }
})
