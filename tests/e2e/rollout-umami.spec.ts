// Ruling 38 (finding 6): the rollout tool's browser checks never send Umami traffic, live or local.
// A page with an Umami-like script on another origin (no "umami" in its URL) and an explicit
// /api/send call; a second server records every request that reaches it.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { checkRequests, freshPage, open } from '../../ci/rollout/checks/requests'

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

let site: Server
let stats: Server
let base = ''
const reached: string[] = []

test.beforeAll(async () => {
  stats = createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' })
    res.end(req.url === '/other.js' ? 'window.otherLoaded = true' : '')
  })
  const statsPort = await listen(stats)
  const statsBase = `http://127.0.0.1:${statsPort}`
  site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="sv"><head><title>Exempel</title>
<script defer src="${statsBase}/s.js" data-website-id="00000000-0000-0000-0000-000000000000"></script>
<script src="${statsBase}/other.js"></script>
</head><body><main>Exempel AB</main>
<script>
  fetch('${statsBase}/api/send', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'event' }) })
    .then((r) => r.text())
  navigator.sendBeacon('http://localhost:${statsPort}/api/send', '{}')
  fetch('${statsBase}/umami/x.js').then((r) => r.text())
</script></body></html>`)
  })
  base = `http://127.0.0.1:${await listen(site)}`
})

test.afterAll(async () => {
  site.close()
  stats.close()
})

test.beforeEach(() => {
  reached.length = 0
})

for (const stub of [false, true]) {
  test(`no Umami request reaches the network (stub: ${stub}); other scripts still load`, async ({ browser }) => {
    const { context, page } = await freshPage(browser, stub)
    try {
      const errors: string[] = []
      page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text())))
      page.on('pageerror', (e) => errors.push(String(e)))
      await open(page, base, '/')
      expect(await page.evaluate('window.otherLoaded')).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
    expect(reached).toEqual(['GET /other.js'])
  })
}

test('checkRequests (live mode) sends no Umami traffic and logs no error for it', async ({ browser }) => {
  const results = await checkRequests(browser, base, ['/'], { stub: false, expectBanner: () => false })
  expect(results).toEqual([expect.objectContaining({ path: '/', errors: [], ok: true })])
  expect(reached).toEqual(['GET /other.js'])
})
