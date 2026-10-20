import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  checkCoverage,
  coverageLines,
  pageTexts,
  shippedTexts,
  css2UrlOf,
  type DeclaredFace,
  distMentions,
  type FontsPage,
  isGoogleFonts,
  judgeFontsPage,
  matchFace,
  parseFontsCss,
  parseWeight,
  shippedStrings,
} from '../../../ci/rollout/checks/fonts'
import { parseCss2 } from '../../../ci/rollout/wire/fonts-css'

const CSS2 = readFileSync(join(import.meta.dirname, 'fixtures/fonts-wire/css2/figtree.css.txt'), 'utf8')
const URL2 = 'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;700&display=swap'
/** A fonts.css as wire writes it: the header, then Google's latin/latin-ext blocks with local urls. */
const FONTS_CSS = `/*\n * Generated from ${URL2}\n * on 2026-10-19 by the astro-consent rollout tool: Google's own faces, served from /fonts/.\n * Subsets: latin, latin-ext. Left out: none.\n */\n${CSS2.replace(/https:\/\/fonts\.gstatic\.com\/\S+?\.woff2/g, (_, i: number) => `/fonts/figtree-${i}.woff2`)}`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'fonts-check-'))
  dirs.push(d)
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true })
    writeFileSync(join(d, p), text)
  }
  return d
}

const page = (over: Partial<FontsPage> = {}): FontsPage => ({
  path: '/',
  width: 1280,
  google: [],
  woff2: [{ url: 'http://127.0.0.1:4399/fonts/figtree-0.woff2', status: 200 }],
  loaded: [{ family: 'Figtree', style: 'normal', weight: '400', status: 'loaded' }],
  used: [{ family: 'Figtree', weight: 400, style: 'normal' }],
  chars: { Figtree: 'Hej på dig' },
  bodyFamily: 'Figtree',
  ...over,
})
const face = (weight: [number, number], style = 'normal', family = 'X'): DeclaredFace => ({ family, style, weight, ranges: [[0, 0xff]], src: '', subset: 'latin' })

describe('parseFontsCss', () => {
  test("wire's fonts.css: every face with family, style, weight, ranges, local src and subset; the header is a comment", () => {
    const faces = parseFontsCss(FONTS_CSS)
    expect(faces.length).toBe(parseCss2(CSS2).length)
    expect(faces[0]).toMatchObject({ family: 'Figtree', style: 'normal', weight: [400, 400], subset: 'latin-ext' })
    expect(faces[1]!.src).toMatch(/^\/fonts\/figtree-\d+\.woff2$/)
    expect(faces[1]!.ranges[0]).toEqual([0, 0xff])
    expect(css2UrlOf(FONTS_CSS)).toBe(URL2)
    expect(css2UrlOf('@font-face{}')).toBeNull()
  })

  test('weights: static, variable ranges, keywords; a block without unicode-range covers everything', () => {
    expect(parseWeight('400')).toEqual([400, 400])
    expect(parseWeight('100 900')).toEqual([100, 900])
    expect(parseWeight('bold')).toEqual([700, 700])
    expect(parseWeight(null)).toEqual([400, 400])
    expect(parseFontsCss("@font-face { font-family: 'Y'; src: url(/fonts/y.woff2) }")[0]).toMatchObject({ weight: [400, 400], style: 'normal', ranges: [[0, 0x10ffff]] })
  })

  test('isGoogleFonts: the two hosts only', () => {
    expect(isGoogleFonts('https://fonts.googleapis.com/css2?family=X')).toBe(true)
    expect(isGoogleFonts('https://fonts.gstatic.com/s/x.woff2')).toBe(true)
    expect(isGoogleFonts('https://www.google.com/maps/embed')).toBe(false)
    expect(isGoogleFonts('not a url')).toBe(false)
  })
})

describe('matchFace (CSS font matching)', () => {
  const faces = [face([400, 400]), face([700, 700]), face([300, 300], 'italic')]
  test('the exact weight, else the nearest by the CSS rules; style first', () => {
    expect(matchFace(faces, 700, 'normal').map((f) => f.weight)).toEqual([[700, 700]])
    expect(matchFace(faces, 600, 'normal').map((f) => f.weight)).toEqual([[700, 700]])
    expect(matchFace(faces, 450, 'normal').map((f) => f.weight)).toEqual([[400, 400]])
    expect(matchFace(faces, 200, 'normal').map((f) => f.weight)).toEqual([[400, 400]])
    expect(matchFace(faces, 800, 'italic').map((f) => [f.style, f.weight])).toEqual([['italic', [300, 300]]])
    expect(matchFace([face([100, 900])], 650, 'normal')).toHaveLength(1)
    expect(matchFace([face([400, 400], 'italic')], 400, 'normal').map((f) => f.style)).toEqual(['italic'])
  })
})

describe('judgeFontsPage (b, c)', () => {
  const declared = parseFontsCss(FONTS_CSS)
  test('control: no Google request, woff2 200, the face used loaded', () => {
    const j = judgeFontsPage(page(), declared)
    expect(j.ok).toBe(true)
    expect(j.lines[0]).toMatch(/^\/ 1280px: ok \(google 0, woff2 1×200, loaded Figtree 400 normal\)$/)
  })
  test('a Google Fonts request, a woff2 that is not 200 or failed, a used face not loaded: each fails', () => {
    expect(judgeFontsPage(page({ google: ['https://fonts.googleapis.com/css2?family=Figtree'] }), declared)).toMatchObject({ ok: false })
    const bad = judgeFontsPage(page({ woff2: [{ url: 'http://h/fonts/a.woff2', status: 404 }, { url: 'http://h/fonts/b.woff2', status: 0 }] }), declared)
    expect(bad.ok).toBe(false)
    expect(bad.lines.join('\n')).toMatch(/404 http:\/\/h\/fonts\/a\.woff2[\s\S]*failed http:\/\/h\/fonts\/b\.woff2/)
    const notLoaded = judgeFontsPage(page({ used: [{ family: 'Figtree', weight: 700, style: 'normal' }] }), declared)
    expect(notLoaded.ok).toBe(false)
    expect(notLoaded.lines.join('\n')).toContain('Figtree 700 normal (face normal 700-700 not loaded)')
    expect(judgeFontsPage(page({ loaded: [{ family: 'Figtree', style: 'normal', weight: '400', status: 'error' }] }), declared).ok).toBe(false)
  })
  test('a family that is not in fonts.css (a system font, an icon font) is not ours to judge', () => {
    expect(judgeFontsPage(page({ used: [{ family: 'Font Awesome 6 Free', weight: 900, style: 'normal' }], loaded: [] }), declared).ok).toBe(true)
  })
  test('family names compare without quotes or case', () => {
    expect(judgeFontsPage(page({ used: [{ family: 'figtree', weight: 400, style: 'normal' }], loaded: [{ family: '"Figtree"', style: 'normal', weight: '400', status: 'loaded' }] }), declared).ok).toBe(true)
  })
})

describe('checkCoverage (d)', () => {
  const declared = parseFontsCss(FONTS_CSS)
  // Google's answer with a cyrillic subset the site left out.
  const google = [
    ...parseCss2(CSS2),
    { subset: 'cyrillic', family: 'Figtree', style: 'normal', weight: '400', src: '', block: '', ranges: [[0x400, 0x45f]] as [number, number][] },
  ]
  test('a character outside the kept ranges that Google offered fails, with the family, the characters and where', () => {
    const c = checkCoverage([{ family: 'Figtree', text: 'Hej Привет', from: '/om/' }], declared, google)
    expect(c.missing).toEqual([{ family: 'Figtree', codePoints: [0x41f, 0x432, 0x435, 0x438, 0x440, 0x442], from: ['/om/'] }])
    expect(coverageLines(c)[0]).toMatch(/^characters shown in Figtree outside its kept unicode-ranges .*U\+041F П.* in \/om\/$/)
  })
  test('one Google never had for the family is a note (main showed a fallback too); unknown Google answer: it fails', () => {
    const c = checkCoverage([{ family: 'Figtree', text: '☎', from: '/' }], declared, google)
    expect(c.missing).toEqual([])
    expect(c.notes[0]).toMatch(/U\+260E ☎ not in any face Google has for it either/)
    expect(checkCoverage([{ family: 'Figtree', text: '☎', from: '/' }], declared, null).missing).toHaveLength(1)
  })
  test('latin, latin-ext, whitespace and invisible characters pass; other families are not checked', () => {
    const c = checkCoverage(
      [
        { family: 'Figtree', text: 'Åäö ÉŁŻ ŉ – “” € ™  ​﻿\t\n', from: '/' },
        { family: 'Arial', text: 'Привет', from: '/' },
      ],
      declared,
      google,
    )
    expect(c).toEqual({ missing: [], notes: [] })
  })
  test("pageTexts: page characters per family; shippedTexts: shipped strings in / 's body family (checked apart: notes only)", () => {
    const pages = [page({ path: '/om/', bodyFamily: 'Arial' }), page({ chars: { Figtree: 'a', Arial: 'b' } })]
    expect(pageTexts(pages)).toEqual([
      { family: 'Figtree', text: 'Hej på dig', from: '/om/' },
      { family: 'Figtree', text: 'a', from: '/' },
      { family: 'Arial', text: 'b', from: '/' },
    ])
    expect(shippedTexts(pages, [{ file: '_astro/x.js', text: 'Привет' }])).toEqual([{ family: 'Figtree', text: 'Привет', from: '_astro/x.js' }])
  })
})

describe('dist scan (a) and shipped strings', () => {
  test('a Google host outside comments is reported; CSS and HTML comments, binaries and source maps are not', () => {
    const dist = tree({
      'index.html': '<!-- fonts.googleapis.com was here --><html></html>',
      '_astro/a.css': '/* Generated from https://fonts.googleapis.com/css2?family=X */@font-face{src:url(/fonts/x.woff2)}',
      '_astro/a.js.map': '{"sources":["https://fonts.gstatic.com"]}',
      'fonts/x.woff2': 'wOF2\u0000fonts.gstatic.com',
    })
    expect(distMentions(dist)).toEqual([])
    writeFileSync(join(dist, 'om.html'), '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet">')
    writeFileSync(join(dist, '_astro/b.js'), 'const u="https://fonts.gstatic.com/s/x.woff2"')
    expect(distMentions(dist).map((m) => m.split(':')[0])).toEqual(['_astro/b.js', 'om.html'])
  })

  test('M11: a Google host outside a comment in a built .css (a leftover @import) is reported', () => {
    const dist = tree({ '_astro/index.css': '/* fonts */@import url(https://fonts.googleapis.com/css2?family=X);body{color:red}' })
    expect(distMentions(dist).map((m) => m.split(':')[0])).toEqual(['_astro/index.css'])
  })

  test('an HTML <style>: CSS comments in it are skipped, a host outside them is reported', () => {
    const ok = tree({ 'index.html': '<style>/* was https://fonts.googleapis.com/css2 */body{}</style><p>hej</p>' })
    expect(distMentions(ok)).toEqual([])
    const bad = tree({ 'index.html': '<style>/* a */@import url("https://fonts.googleapis.com/css2?family=X");</style>' })
    expect(distMentions(bad).map((m) => m.split(':')[0])).toEqual(['index.html'])
  })

  test('shipped strings: literal characters and \\u escapes of JS, string values of JSON; a regex range like \\u0400-\\u04FF is skipped', () => {
    const dist = tree({
      '_astro/a.js': 'const a="Привет",b="\\u2192";const re=/[\\u0400-\\u04FF]/',
      'data.json': JSON.stringify({ title: 'Ελλάδα', n: 3, list: ['ok'] }),
      'broken.json': '{',
    })
    const s = shippedStrings(dist)
    expect(s.map((x) => x.file)).toEqual(['_astro/a.js', 'data.json'])
    const js = s[0]!.text
    expect(js).toContain('Привет')
    expect(js).toContain('→')
    expect(js).not.toContain('Ѐ')
    expect(js).not.toContain('ӿ')
    expect(s[1]!.text).toBe('Ελλάδα ok')
  })
})
