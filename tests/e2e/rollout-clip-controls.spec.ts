// #115: a client site set `--border: #e6e3dd` (a colour) on :root. DaisyUI 5 reads --border as a
// border width, so every rule using it became invalid: the settings view's switches shrank to 5px
// with no border, the "Alltid på" badge lost its padding and border, and the placeholder's "Visa
// alltid" checkbox had none. Contrast and clip passed. Step 5 now reports a control with no border.
//
// The demo is served through two proxies: one as built, one with the site's variable added.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, expect, test } from '@playwright/test'
import { checkClip } from '../../ci/rollout/checks/clip'

const SITE_VARIABLE = '<style>:root{--border:#e6e3dd}</style>'
// Review of #140: size tokens set to colours shrink the switches to 2px and checkboxes to 8px, border intact.
const SIZE_VARIABLES = '<style>:root{--size-selector:#e6e3dd;--size-field:#eee}</style>'

function proxy(demo: string, inject: string): Server {
  return createServer(async (req, res) => {
    const upstream = await fetch(demo + (req.url ?? '/'))
    const type = upstream.headers.get('content-type') ?? 'application/octet-stream'
    const body = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, { 'content-type': type })
    res.end(type.includes('text/html') ? body.toString('utf8').replace('</head>', `${inject}</head>`) : body)
  })
}

const servers: Server[] = []
const listen = async (s: Server): Promise<string> => {
  servers.push(s)
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', () => done()))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
let plain = ''
let broken = ''
let shrunk = ''

test.beforeAll(async ({}, info) => {
  // The consent demo the config serves (baseURL).
  const demo = String(info.project.use.baseURL)
  plain = await listen(proxy(demo, ''))
  broken = await listen(proxy(demo, SITE_VARIABLE))
  shrunk = await listen(proxy(demo, SIZE_VARIABLES))
})
test.afterAll(() => servers.forEach((s) => s.close()))

test('step 5 reports the banner and placeholder controls that a site variable left without a border (#115)', async () => {
  test.setTimeout(120_000)
  const browser = await chromium.launch()
  try {
    const ok = (await checkClip(browser, plain, ['/karta'], [360, 1280], { stub: true })).filter((r) => r.kind === 'control')
    const kinds = (rows: typeof ok) => [...new Set(rows.map((r) => r.button.split(' ')[0]))].sort()
    // The settings view's switches and badge, and the placeholder's checkbox, at both widths.
    expect(kinds(ok)).toEqual(['badge', 'checkbox', 'toggle'])
    expect(new Set(ok.map((r) => r.width))).toEqual(new Set([360, 1280]))
    expect(ok.filter((r) => r.clipped), 'as built, every control has its border').toEqual([])

    const bad = (await checkClip(browser, broken, ['/karta'], [360], { stub: true })).filter((r) => r.kind === 'control')
    expect(kinds(bad)).toEqual(['badge', 'checkbox', 'toggle'])
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((r) => r.bare && r.clipped && r.border === '0px none'), 'with --border set to a colour, every control lost its border').toBe(true)

    // The size tokens: border kept, but the switches and checkboxes shrink to a sliver.
    const small = (await checkClip(browser, shrunk, ['/karta'], [360], { stub: true })).filter((r) => r.kind === 'control' && !r.button.startsWith('badge'))
    expect(small.length).toBeGreaterThan(0)
    expect(small.every((r) => r.tiny && r.clipped && !r.bare), 'with --size-* set to colours, every switch and checkbox is too small').toBe(true)
  } finally {
    await browser.close()
  }
})
