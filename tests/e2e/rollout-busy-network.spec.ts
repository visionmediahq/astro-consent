// aspokarlsson: a page whose network never goes quiet (a looping background video keeps its
// download open; polling and websockets do the same) never reaches Playwright's networkidle.
// The rollout checks must still open it: load, then a bounded wait for networkidle.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, expect, test } from '@playwright/test'
import { freshPage, gotoPage, open } from '../../ci/rollout/checks/requests'

let site: Server
let base = ''

test.beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === '/hang') {
      // Headers and one chunk, then nothing: the request stays open for as long as the page does.
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write('x')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="sv"><head><title>Exempel</title></head>
<body><main id="m">Exempel AB</main><script>fetch('/hang')</script></body></html>`)
  })
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', () => done()))
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
})

test.afterAll(() => {
  site.closeAllConnections()
  site.close()
})

test('open and gotoPage load a page whose network never goes idle', async () => {
  test.setTimeout(90_000)
  const browser = await chromium.launch()
  try {
    const { context, page } = await freshPage(browser, true)
    const t0 = Date.now()
    await open(page, base, '/')
    await expect(page.locator('#m')).toHaveText('Exempel AB')
    await gotoPage(page, `${base}/`)
    await expect(page.locator('#m')).toHaveText('Exempel AB')
    // Two bounded idle waits plus open's scroll and settle, far under the 45 s load timeout.
    expect(Date.now() - t0).toBeLessThan(40_000)
    await context.close()
  } finally {
    await browser.close()
  }
})
