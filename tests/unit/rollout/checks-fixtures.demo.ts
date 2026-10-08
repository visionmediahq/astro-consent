// Negative controls for ci/rollout/checks: small broken pages that a check must NOT pass.
// A script, not a vitest file:   npx tsx tests/unit/rollout/checks-fixtures.demo.ts
// The pages are written to a temp dir and served on 127.0.0.1. Every registry URL in them is
// either never requested or fulfilled by the stub (stub: true): nothing reaches Google or Meta.
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { checkClip } from '../../../ci/rollout/checks/clip'
import { checkConsentPaths } from '../../../ci/rollout/checks/consent-paths'
import { checkRequests } from '../../../ci/rollout/checks/requests'

const MAPS = 'https://www.google.com/maps/embed?pb=fixture'
const GTAG = 'https://www.googletagmanager.com/gtag/js?id=G-FIXTURE'
const PIXEL = 'https://connect.facebook.net/en_US/fbevents.js'

const banner = (style = 'position:fixed;bottom:0;left:0;right:0;background:#fff;padding:8px') =>
  `<section data-consent-banner style="${style}"><button data-consent-action="none">Neka</button><button data-consent-action="all">Acceptera alla</button></section>`
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0">${body}</body></html>`

// A fake client for the consent-path fixtures: Neka hides the banner; data-load runs `onLoad`.
const embedPage = (onLoad: string, onStart = '') =>
  page(`${banner()}
  <div data-consent-embed="google-maps" id="a"><button data-load>Visa</button><input type="checkbox" data-remember><a data-open href="${MAPS}">Öppna</a></div>
  <div data-consent-embed="google-maps" id="b"><button data-load>Visa</button><input type="checkbox" data-remember><a data-open href="${MAPS}">Öppna</a></div>
  <script>
    const add = (el) => { const f = document.createElement('iframe'); f.src = '${MAPS}'; el.appendChild(f); el.setAttribute('data-active', '') }
    document.querySelector('[data-consent-action=none]').onclick = () => { document.querySelector('[data-consent-banner]').hidden = true }
    ${onStart}
    for (const b of document.querySelectorAll('[data-load]')) b.onclick = (e) => { const el = e.target.closest('[data-consent-embed]'); ${onLoad} }
  </script>`)

const LATE = `${banner()}<div style="height:10000px;position:relative"><div id="s" style="position:absolute;top:3000px;height:10px"></div></div>
    <script>new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { o.disconnect(); const s = document.createElement('script'); s.src = '${GTAG}'; document.head.appendChild(s) } }).observe(document.getElementById('s'))</script>`

const FIXTURES: Record<string, string> = {
  // Banner controls and look-alikes.
  ok: page(banner()),
  transparent: page(banner('position:fixed;bottom:0;left:0;right:0;opacity:0')),
  covered: page(`${banner()}<div style="position:fixed;inset:0;z-index:10;background:#fff"></div>`),
  offscreen: page(banner('position:fixed;top:-500px;left:0;right:0;background:#fff')),
  two: page(banner() + banner()),
  // Item 1: a lazy embed that is in the DOM but never requested, and one that loads only mid-page.
  lazy: page(`${banner()}<iframe data-src="${MAPS}"></iframe>`),
  late: page(LATE),
  // The same with smooth scrolling (a fleet site's global.css sets it): scrollBy animates.
  smooth: page(`<style>html { scroll-behavior: smooth }</style>${LATE}`),
  // Item 4: "Visa" that is not one-off, and "Visa" that loads another service too.
  sticky: embedPage(`add(el); localStorage.setItem('sticky', '1')`, `if (localStorage.getItem('sticky')) document.querySelectorAll('[data-consent-embed]').forEach(add)`),
  other: embedPage(`add(el); const s = document.createElement('script'); s.src = '${PIXEL}'; document.head.appendChild(s)`),
  oneoff: embedPage(`add(el)`),
  // Item 7: a button inside its (too wide) container but outside the viewport; a page that scrolls sideways.
  offbtn: page(`<section data-consent-banner style="position:absolute;top:0;left:0;width:1000px;background:#fff"><button data-consent-action="none" style="margin-left:900px">Neka</button></section>`),
  wide: page(`${banner()}<div style="width:2000px;height:10px"></div>`),
}

const dir = mkdtempSync(join(tmpdir(), 'checks-fixtures-'))
for (const [name, html] of Object.entries(FIXTURES)) {
  mkdirSync(join(dir, name))
  writeFileSync(join(dir, name, 'index.html'), html)
}
const server = createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0]!.replace(/^\/|\/$/g, '')
  try {
    const body = readFileSync(join(dir, name, 'index.html'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body)
  } catch {
    res.writeHead(404).end('nope')
  }
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const address = server.address()
const BASE = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

const browser = await chromium.launch()
let failed = false
const expect = (cond: boolean, what: string, detail: unknown) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(detail)}`)
  if (!cond) failed = true
}
try {
  const req = async (path: string) => (await checkRequests(browser, BASE, [path], { stub: true }))[0]!

  for (const path of ['/ok/']) {
    const r = await req(path)
    expect(r.banner && r.ok, `${path} control: banner shown, ok`, r)
  }
  for (const path of ['/transparent/', '/covered/', '/offscreen/']) {
    const r = await req(path)
    expect(!r.banner && !r.ok, `${path} banner not shown`, r)
  }
  {
    let r: unknown
    try {
      r = await req('/two/')
      const two = r as Awaited<ReturnType<typeof req>>
      expect(!two.ok && two.banners === 2 && /2 banners/.test(two.bannerProblem ?? ''), '/two/ reported, not thrown', r)
    } catch (e) {
      expect(false, '/two/ reported, not thrown', String(e).split('\n')[0])
    }
  }
  {
    const r = await req('/lazy/')
    expect(r.blocked.some((b) => b.startsWith('in DOM, not requested:')) && !r.ok, '/lazy/ data-src iframe counted', r.blocked)
  }
  for (const path of ['/late/', '/smooth/']) {
    const r = await req(path)
    expect(r.blocked.some((b) => b.startsWith('https://www.googletagmanager.com/')) && !r.ok, `${path} mid-page loader seen`, r.blocked)
  }

  const paths = async (path: string) => (await checkConsentPaths(browser, BASE, [path]))[0]!
  {
    const r = await paths('/oneoff/')
    expect(r.visaLoadsOnlyClicked && r.filterKept === null, '/oneoff/ control: one-off Visa passes, filter not asserted', r)
  }
  {
    const r = await paths('/sticky/')
    expect(!r.visaLoadsOnlyClicked, '/sticky/ Visa that survives a reload fails', r)
  }
  {
    const r = await paths('/other/')
    expect(!r.visaLoadsOnlyClicked, '/other/ Visa that loads another service fails', r)
  }

  {
    const rows = await checkClip(browser, BASE, ['/offbtn/'], [360])
    expect(rows.some((r) => r.button === 'Neka' && r.clipped), '/offbtn/ button outside the viewport', rows)
  }
  {
    const rows = await checkClip(browser, BASE, ['/wide/'], [360])
    expect(rows.some((r) => r.kind === 'page' && r.clipped), '/wide/ horizontal page scroll', rows)
  }
} finally {
  await browser.close()
  server.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
