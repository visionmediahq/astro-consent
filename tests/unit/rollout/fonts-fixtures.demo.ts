// Negative controls for verify step 8 (ci/rollout/checks/fonts.ts): a tiny site serving its own
// fonts, pages a check must FAIL and controls it must PASS.
// A script, not a vitest file:   npx tsx tests/unit/rollout/fonts-fixtures.demo.ts
// Served on 127.0.0.1. Every Google Fonts request is aborted by the check (block: true) and
// counted: nothing reaches Google. The font bytes are a TrueType file Playwright ships (Chromium
// loads a font by its signature, whatever the name), copied at run time, never committed.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import { checkCoverage, checkFonts, judgeFontsPage, pageTexts, parseFontsCss } from '../../../ci/rollout/checks/fonts'
import { type Face, parseUnicodeRange } from '../../../ci/rollout/wire/fonts-css'

/** The first .ttf under playwright-core (its trace viewer's icon font). */
function fontBytes(): Buffer {
  const root = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'))
  const find = (dir: string): string | null => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) {
        const hit = find(p)
        if (hit) return hit
      } else if (e.endsWith('.ttf')) return p
    }
    return null
  }
  const file = find(root)
  if (!file) throw new Error(`no .ttf under ${root}: the fixture needs a font file to serve`)
  return readFileSync(file)
}

const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+20AC'
const CYRILLIC = 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'
const face = (weight: number, file: string, range = LATIN) =>
  `/* latin */\n@font-face {\n  font-family: 'Fixture Sans';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(/fonts/${file}) format('woff2');\n  unicode-range: ${range};\n}\n`
/** The site's fonts.css: 400 and 700, latin only (700's file is missing on the /bold/ fixture). */
const FONTS_CSS = `/*\n * Generated from https://fonts.googleapis.com/css2?family=Fixture+Sans:wght@400;700\n * on 2026-10-19 by the astro-consent rollout tool: Google's own faces, served from /fonts/.\n */\n${face(400, 'fixture-sans-normal-400-latin-00000000.woff2')}${face(700, 'fixture-sans-normal-700-latin-11111111.woff2')}`
/** Google's whole answer for the URL: latin and cyrillic, so a Cyrillic character was offered. */
const GOOGLE: Face[] = [
  { subset: 'cyrillic', family: 'Fixture Sans', style: 'normal', weight: '400', src: '', block: '', ranges: parseUnicodeRange(CYRILLIC) },
  { subset: 'latin', family: 'Fixture Sans', style: 'normal', weight: '400', src: '', block: '', ranges: parseUnicodeRange(LATIN) },
]

const page = (body: string, head = '') =>
  `<!doctype html><html lang="sv"><head><meta charset="utf-8"><link rel="stylesheet" href="/fonts.css">${head}</head><body style="font-family:'Fixture Sans',sans-serif;margin:0">${body}</body></html>`
const FIXTURES: Record<string, string> = {
  // Controls: self-hosted, nothing from Google; a 700 used where only the file of 400 loads is not one.
  clean: page('<h1 style="font-weight:400">Välkommen till oss</h1><p>Hej på dig, åäö ÅÄÖ – “citat” €</p>'),
  // A leftover Google Fonts link: blocked and counted.
  google: page('<p>Hej</p>', '<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fixture+Sans&display=swap">'),
  // Bold text whose face (700) is declared but its file is missing: a 404 and a face not loaded.
  bold: page('<p style="font-weight:700">Fet text</p>'),
  // A Cyrillic word in the self-hosted family, which kept latin only.
  cyrillic: page('<p>Hej och Привет</p>'),
  // An emoji, which no Google text face has: a fallback on main too, so a note, not a failure.
  emoji: page('<p>Ring oss ☎ 📞</p>'),
}

const font = fontBytes()
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]!
  if (url === '/fonts.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(FONTS_CSS)
  if (url === '/fonts/fixture-sans-normal-400-latin-00000000.woff2') return res.writeHead(200, { 'content-type': 'font/woff2' }).end(font)
  const name = url.replace(/^\/|\/$/g, '')
  const html = FIXTURES[name]
  if (html) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  res.writeHead(404).end('nope')
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const address = server.address()
const BASE = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
const declared = parseFontsCss(FONTS_CSS)

const browser = await chromium.launch()
let failed = false
const expect = (cond: boolean, what: string, detail: unknown) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(detail).slice(0, 600)}`)
  if (!cond) failed = true
}
try {
  const run = (path: string) => checkFonts(browser, BASE, [path], { stub: true, block: true })
  {
    const pages = await run('/clean/')
    const judged = pages.map((p) => judgeFontsPage(p, declared))
    expect(pages.length === 2 && judged.every((j) => j.ok), '/clean/ control at 360 and 1280: no Google, woff2 200, face loaded', judged)
    const cov = checkCoverage(pageTexts(pages), declared, GOOGLE)
    expect(cov.missing.length === 0, '/clean/ control: every character in a kept face', cov)
  }
  {
    const pages = await run('/google/')
    const judged = pages.map((p) => judgeFontsPage(p, declared))
    expect(pages.every((p) => p.google.length > 0) && judged.every((j) => !j.ok && j.lines.some((l) => /request\(s\) to Google Fonts/.test(l))), '/google/ a page that asks Google Fonts fails', judged)
    // The blocking itself: every Google request failed with the abort's own reason, none was sent.
    expect(pages.every((p) => p.googleAborted === p.google.length), '/google/ every Google Fonts request aborted (net::ERR_BLOCKED_BY_CLIENT), not sent', pages.map((p) => [p.google.length, p.googleAborted]))
  }
  {
    const judged = (await run('/bold/')).map((p) => judgeFontsPage(p, declared))
    expect(judged.every((j) => !j.ok && j.lines.some((l) => /404/.test(l)) && j.lines.some((l) => /Fixture Sans 700 normal/.test(l))), '/bold/ a used face whose file 404s fails (404 and not loaded)', judged)
  }
  {
    const pages = await run('/cyrillic/')
    const cov = checkCoverage(pageTexts(pages), declared, GOOGLE)
    expect(cov.missing.length === 1 && cov.missing[0]!.family === 'Fixture Sans' && cov.missing[0]!.codePoints.includes(0x41f), '/cyrillic/ a character outside the kept ranges fails, family and characters listed', cov)
    const strict = checkCoverage(pageTexts(pages), declared, null)
    expect(strict.missing.length === 1, '/cyrillic/ without Google\'s answer: fails too', strict)
  }
  {
    const pages = await run('/emoji/')
    const cov = checkCoverage(pageTexts(pages), declared, GOOGLE)
    expect(cov.missing.length === 0 && cov.notes.some((n) => /U\+260E/.test(n)), '/emoji/ control: a character Google never had is noted, not failed', cov)
  }
} finally {
  await browser.close()
  server.close()
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
