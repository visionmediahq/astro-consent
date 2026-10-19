// Self-hosting a site's Google Fonts (site-factory#220, PR 2: wire). Every response is recorded:
// fixtures/fonts-wire/css2/ holds Google's css2 answers to a Chrome User-Agent, woff2 bodies are
// tiny fakes ("wOF2" + their URL), licence texts are two-line stand-ins. Nothing reaches the network.
//
// The before trees are the detect fixtures (fixtures/fonts/<site>/); fixtures/fonts-wire/expected/
// holds every file wire edits, written by hand before the code.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectFonts } from '../../../ci/rollout/detect/fonts'
import { fixtureSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import { parseFontsArgs, parseWireArgs, runDetect, runFonts, runWire } from '../../../ci/rollout/run'
import type { FontsInfo, FontsPlan } from '../../../ci/rollout/types'
import { applyEdits } from '../../../ci/rollout/wire/engine'
import { codePointsOf, fontFileName, parseCss2, parseUnicodeRange, selectFaces } from '../../../ci/rollout/wire/fonts-css'
import { CHROME_UA, FONTS_BRANCH, FONTS_COMMIT_MESSAGE, type FontFetch, licenceUrls, planFonts } from '../../../ci/rollout/wire/fonts'
import { BRANCH, COMMIT_MESSAGE } from '../../../ci/rollout/wire/index'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const WIRE = join(FIXTURES, 'fonts-wire')
const ENTRY = 'src/styles/global.css'
const DATE = new Date('2026-10-19T12:00:00Z')

const URLS = {
  knutssonsbil: 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Barlow:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap',
  ernstedt: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap',
  arjangs: 'https://fonts.googleapis.com/css2?family=Kanit:wght@500;600;700;800&family=Open+Sans:wght@400;500;600;700&display=swap',
  figtree: 'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap',
  kfk: 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500&display=swap',
  onoffshore: 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Big+Shoulders+Text:wght@600;700;800&display=swap',
  ahatrafikskola:
    'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap',
} as const
const css2 = (name: keyof typeof URLS): string => readFileSync(join(WIRE, 'css2', `${name === 'knutssonsbil' ? 'knut' : name}.css.txt`), 'utf8')

interface Answer {
  status: number
  contentType: string
  body: Uint8Array
}
const text = (s: string, contentType = 'text/plain; charset=utf-8', status = 200): Answer => ({ status, contentType, body: new TextEncoder().encode(s) })
/**
 * A woff2 stand-in: the signature, a NUL (binary, as detect tells it) and a hash of the URL, so
 * every file differs, hashes are stable and no Google host is in the bytes.
 */
const fakeWoff2 = (url: string): Uint8Array => new TextEncoder().encode(`wOF2\u0000${createHash('sha256').update(url).digest('hex').slice(0, 16)}`)
const licenceText = (dir: string): string =>
  `Copyright 2020 The ${dir} Project Authors (https://example.org/${dir})\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n`

/**
 * A recorded network: the css2 fixtures by URL (only for the Chrome User-Agent), a fake woff2 for
 * every fonts.gstatic.com URL, an OFL text for every google/fonts ofl/ path. `over` replaces any URL.
 */
function network(over: Record<string, Answer | Error> = {}, extraCss: Record<string, string> = {}): FontFetch & { calls: string[] } {
  const calls: string[] = []
  const byUrl = new Map<string, string>([...Object.entries(URLS).map(([k, u]) => [u, css2(k as keyof typeof URLS)] as const), ...Object.entries(extraCss)])
  const fetch = async (url: string, headers: Record<string, string>): Promise<Answer> => {
    calls.push(url)
    const o = over[url]
    if (o instanceof Error) throw o
    if (o) return o
    const css = byUrl.get(url)
    if (css !== undefined) {
      expect(headers['User-Agent']).toBe(CHROME_UA)
      return text(css, 'text/css; charset=utf-8')
    }
    if (/^https:\/\/fonts\.gstatic\.com\/.+\.woff2$/.test(url)) return { status: 200, contentType: 'font/woff2', body: fakeWoff2(url) }
    const ofl = /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/main\/ofl\/([a-z0-9]+)\/OFL\.txt$/.exec(url)
    if (ofl) return text(licenceText(ofl[1]!))
    return text('404: Not Found', 'text/plain', 404)
  }
  return Object.assign(fetch, { calls })
}

/** `base` with `extra` files added or replaced (string), or removed (null), in memory. */
function withFiles(base: SiteFiles | null, extra: Record<string, string | null>): SiteFiles {
  const added = Object.entries(extra).flatMap(([p, t]) => (t === null ? [] : [p]))
  const removed = new Set(Object.entries(extra).flatMap(([p, t]) => (t === null ? [p] : [])))
  return {
    root: base?.root ?? '/nowhere',
    list: (glob) => [...new Set([...(base?.list(glob) ?? []), ...added.filter((p) => globToRegExp(glob).test(p))])].filter((p) => !removed.has(p)).sort(),
    read: (path) => {
      const t = extra[path]
      if (typeof t === 'string') return t
      if (removed.has(path) || !base) throw new Error(`ENOENT ${path}`)
      return base.read(path)
    },
    exists: (path) => typeof extra[path] === 'string' || (!removed.has(path) && (base?.exists(path) ?? false)),
  }
}

/** Every `.txt` file under `dir`, site-relative, suffix removed. */
function treeOf(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.name.endsWith('.txt')) out.set(relative(dir, full).split(sep).join('/').slice(0, -'.txt'.length), readFileSync(full, 'utf8'))
    }
  }
  visit(dir)
  return out
}

const fontsSite = (name: string): SiteFiles => fixtureSite(join(FIXTURES, 'fonts', name))
const MIDDLEWARE = readFileSync(join(FIXTURES, 'fonts', 'olarpsvasstak', 'src', 'middleware.ts.txt'), 'utf8')
/** The before tree of each golden case. */
const CASES: Record<string, () => SiteFiles> = {
  knutssonsbil: () => fontsSite('knutssonsbil'),
  ahatrafikskola: () => fontsSite('ahatrafikskola'),
  ernstedt: () => fontsSite('ernstedt'),
  'arjangs-elmontage': () => fontsSite('arjangs-elmontage'),
  ljrevision: () => fontsSite('ljrevision'),
  kfkmekan: () => fontsSite('kfkmekan'),
  onoffshore: () => fontsSite('onoffshore'),
  'knutssonsbil-middleware': () => withFiles(fontsSite('knutssonsbil'), { 'src/middleware.ts': MIDDLEWARE }),
}

const reportOf = (files: SiteFiles, entry: string | null = ENTRY): { fonts: FontsInfo; css: { entry: string | null } } => ({ fonts: detectFonts(files, entry), css: { entry } })

function ok(plan: FontsPlan): Extract<FontsPlan, { ok: true }> {
  if (!plan.ok) throw new Error(`refused: ${JSON.stringify(plan.refusals, null, 2)}`)
  return plan
}

async function refused(files: SiteFiles, fetch: FontFetch, fragment: string | RegExp, report = reportOf(files)): Promise<void> {
  const plan = await planFonts(files, report, { fetch, now: DATE })
  expect(plan.ok).toBe(false)
  if (plan.ok) return
  const reasons = plan.refusals.map((r) => r.reason).join('\n')
  if (typeof fragment === 'string') expect(reasons).toContain(fragment)
  else expect(reasons).toMatch(fragment)
}

/** The site after the plan, edits applied and new files added, as SiteFiles (binary files as latin1 text). */
function after(files: SiteFiles, plan: Extract<FontsPlan, { ok: true }>): SiteFiles {
  const over: Record<string, string> = {}
  for (const path of new Set(plan.edits.map((e) => e.file))) over[path] = applyEdits(files.read(path), plan.edits.filter((e) => e.file === path))
  for (const f of plan.newFiles) over[f.path] = f.text
  for (const f of plan.fontFiles) over[f.path] = Buffer.from(f.bytes).toString('latin1')
  return withFiles(files, over)
}

// ── css2 parsing, unicode ranges, subsets, names ─────────────────────────────────────────────

describe('parseCss2', () => {
  test('knutssonsbil: 35 faces in Google order, each with its subset, family, style, weight and woff2 url', () => {
    const faces = parseCss2(css2('knutssonsbil'))
    expect(faces).toHaveLength(35)
    expect(new Set(faces.map((f) => f.family))).toEqual(new Set(['Oswald', 'Barlow']))
    expect(new Set(faces.map((f) => f.subset))).toEqual(new Set(['cyrillic-ext', 'cyrillic', 'vietnamese', 'latin-ext', 'latin']))
    for (const f of faces) {
      expect(f.src).toMatch(/^https:\/\/fonts\.gstatic\.com\/s\/.+\.woff2$/)
      expect(f.block.startsWith('@font-face {')).toBe(true)
      expect(f.block.endsWith('}')).toBe(true)
      expect(f.block).toContain(f.src)
    }
    expect(faces.filter((f) => f.family === 'Barlow' && f.style === 'italic').map((f) => f.weight)).toEqual(['400', '400', '400'])
  })

  test('a variable face keeps its weight range ("400 700") and opsz fonts parse like any other', () => {
    const faces = parseCss2(css2('ernstedt'))
    expect(faces.filter((f) => f.family === 'Fraunces').every((f) => f.weight === '400 700')).toBe(true)
  })

  test('a response without @font-face, with a non-woff2 face, or a face without its subset comment is an error', () => {
    expect(() => parseCss2('<!doctype html><title>Error</title>')).toThrow(/no @font-face/)
    const ttf = "/* latin */\n@font-face {\n  font-family: 'Oswald';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/oswald/v1/a.ttf) format('truetype');\n}\n"
    expect(() => parseCss2(ttf)).toThrow(/woff2/)
    const bare = "@font-face {\n  font-family: 'Oswald';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/oswald/v1/a.woff2) format('woff2');\n}\n"
    expect(() => parseCss2(bare)).toThrow(/subset/)
    const elsewhere = "/* latin */\n@font-face {\n  font-family: 'Oswald';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://example.org/a.woff2) format('woff2');\n}\n"
    expect(() => parseCss2(elsewhere)).toThrow(/fonts\.gstatic\.com/)
  })
})

describe('parseUnicodeRange', () => {
  test('single points, ranges and ? wildcards', () => {
    expect(parseUnicodeRange('U+0000-00FF, U+0131, U+2190-21FF')).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x2190, 0x21ff],
    ])
    expect(parseUnicodeRange('U+4??')).toEqual([[0x400, 0x4ff]])
    expect(parseUnicodeRange('u+1F600-1F64F')).toEqual([[0x1f600, 0x1f64f]])
  })
})

describe('codePointsOf: the characters a site shows', () => {
  test('literal characters, HTML entities (named, decimal, hex), JS and CSS escapes', () => {
    const has = (s: string, cp: number) => codePointsOf(s).has(cp)
    expect(has('Ring oss → nu', 0x2192)).toBe(true)
    expect(has('Läs mer &rarr;', 0x2192)).toBe(true)
    expect(has('&#8594;', 0x2192)).toBe(true)
    expect(has('&#x2192;', 0x2192)).toBe(true)
    expect(has("const arrow = '\\u2192'", 0x2192)).toBe(true)
    expect(has("const arrow = '\\u{1F4DE}'", 0x1f4de)).toBe(true)
    expect(has('a::after { content: "\\2192"; }', 0x2192)).toBe(true)
    expect(has('Привет', 0x41f)).toBe(true)
  })
})

describe('selectFaces: latin, latin-ext, and any subset that covers a character the site shows', () => {
  const swedish = codePointsOf('Välkommen till oss – vi fixar bilen åt dig. Öppet 08–17. © 2026 “Bäst”\n\t')

  test('Swedish text: latin + latin-ext only; cyrillic, cyrillic-ext and vietnamese left out', () => {
    const { kept, extra, dropped } = selectFaces(parseCss2(css2('knutssonsbil')), swedish)
    expect(new Set(kept.map((f) => f.subset))).toEqual(new Set(['latin', 'latin-ext']))
    expect(kept).toHaveLength(18)
    expect(extra).toEqual([])
    expect(dropped).toEqual(['cyrillic', 'cyrillic-ext', 'vietnamese'])
  })

  test('an arrow (U+2192) keeps Open Sans math and symbols, nothing extra for Kanit (no subset has it)', () => {
    const { kept, extra } = selectFaces(parseCss2(css2('arjangs')), new Set([...swedish, 0x2192]))
    const subsets = (family: string) => [...new Set(kept.filter((f) => f.family === family).map((f) => f.subset))].sort()
    expect(subsets('Open Sans')).toEqual(['latin', 'latin-ext', 'math', 'symbols'])
    expect(subsets('Kanit')).toEqual(['latin', 'latin-ext'])
    expect(extra).toEqual([
      { subset: 'math', codePoints: [0x2192] },
      { subset: 'symbols', codePoints: [0x2192] },
    ])
  })

  test('↑ and ↓ are in latin: no extra subset', () => {
    const { extra } = selectFaces(parseCss2(css2('arjangs')), new Set([...swedish, 0x2191, 0x2193]))
    expect(extra).toEqual([])
  })

  test('Cyrillic text keeps the cyrillic subset of every family that has one (Oswald; Barlow has none)', () => {
    const { kept, extra } = selectFaces(parseCss2(css2('knutssonsbil')), new Set([...swedish, ...codePointsOf('Привет')]))
    expect(new Set(kept.filter((f) => f.subset === 'cyrillic').map((f) => f.family))).toEqual(new Set(['Oswald']))
    expect(extra.map((e) => e.subset)).toEqual(['cyrillic'])
  })

  test('tabs, newlines and other controls never pull in a subset (Open Sans symbols covers U+0001-000C)', () => {
    const { extra } = selectFaces(parseCss2(css2('arjangs')), codePointsOf('a\tb\nc\r\u0007'))
    expect(extra).toEqual([])
  })
})

describe('fontFileName', () => {
  const sha8 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 8)
  const bytes = fakeWoff2('https://fonts.gstatic.com/s/barlow/v1/a.woff2')

  test('<family>-<style>-<weight>-<subset>-<sha256 of the bytes, 8 hex>.woff2', () => {
    expect(fontFileName('Barlow', 'italic', ['400'], 'latin', bytes)).toBe(`barlow-italic-400-latin-${sha8(bytes)}.woff2`)
    expect(fontFileName('Big Shoulders Text', 'normal', ['700'], 'latin-ext', bytes)).toBe(`big-shoulders-text-normal-700-latin-ext-${sha8(bytes)}.woff2`)
  })

  test('stable: the same bytes give the same name, one changed byte another', () => {
    const copy = Uint8Array.from(bytes)
    expect(fontFileName('Barlow', 'normal', ['400'], 'latin', copy)).toBe(fontFileName('Barlow', 'normal', ['400'], 'latin', bytes))
    copy[copy.length - 1] = copy[copy.length - 1]! ^ 1
    expect(fontFileName('Barlow', 'normal', ['400'], 'latin', copy)).not.toBe(fontFileName('Barlow', 'normal', ['400'], 'latin', bytes))
  })

  test('a file several weights share (a variable font) is named by its weight range', () => {
    expect(fontFileName('Oswald', 'normal', ['400', '500', '600', '700'], 'latin', bytes)).toMatch(/^oswald-normal-400_700-latin-[0-9a-f]{8}\.woff2$/)
    expect(fontFileName('Fraunces', 'normal', ['400 700'], 'latin', bytes)).toMatch(/^fraunces-normal-400_700-latin-/)
  })
})

describe('licenceUrls', () => {
  test('ofl, apache, ufl in google/fonts, by the family name lower-cased without spaces', () => {
    expect(licenceUrls('Big Shoulders Text')).toEqual([
      { licence: 'OFL', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bigshoulderstext/OFL.txt' },
      { licence: 'Apache-2.0', url: 'https://raw.githubusercontent.com/google/fonts/main/apache/bigshoulderstext/LICENSE.txt' },
      { licence: 'UFL', url: 'https://raw.githubusercontent.com/google/fonts/main/ufl/bigshoulderstext/UFL.txt' },
    ])
  })
})

// ── planFonts: golden edits per load pattern ─────────────────────────────────────────────────

describe('planFonts on the detect fixtures: every edited file comes out as fonts-wire/expected/', () => {
  test.each(Object.keys(CASES))('%s', async (name) => {
    const files = CASES[name]!()
    const report = reportOf(files)
    expect(report.fonts.status).toBe('wire')
    const plan = ok(await planFonts(files, report, { fetch: network(), now: DATE }))
    const expected = treeOf(join(WIRE, 'expected', name))
    expect([...new Set(plan.edits.map((e) => e.file))].sort()).toEqual([...expected.keys()].sort())
    for (const [path, want] of expected) expect(applyEdits(files.read(path), plan.edits.filter((e) => e.file === path)), path).toBe(want)
    expect(plan.newFiles.map((f) => f.path)).toContain('src/styles/fonts.css')
    for (const f of plan.fontFiles) expect(f.path).toMatch(/^public\/fonts\/[a-z0-9-]+-(?:normal|italic)-[0-9_]+-[a-z-]+-[0-9a-f]{8}\.woff2$/)
    // After wiring, detect sees a self-hosted site: no Google reference is left anywhere.
    const wired = detectFonts(after(files, plan), ENTRY)
    expect(wired).toMatchObject({ status: 'self-hosted', reasons: [], locations: [], csp: [] })
  })

  test('knutssonsbil: fonts.css is the header, then Google\'s latin and latin-ext blocks verbatim with local urls', async () => {
    const files = CASES['knutssonsbil']!()
    const plan = ok(await planFonts(files, reportOf(files), { fetch: network(), now: DATE }))
    const css = plan.newFiles.find((f) => f.path === 'src/styles/fonts.css')!.text
    const header = [
      '/*',
      ` * Generated from ${URLS.knutssonsbil}`,
      ' * on 2026-10-19 by the astro-consent rollout tool: Google\'s own faces, served from /fonts/.',
      ' * Subsets: latin, latin-ext. Left out: cyrillic, cyrillic-ext, vietnamese.',
      ' * Licences: /fonts/LICENSE-barlow.txt (OFL), /fonts/LICENSE-oswald.txt (OFL).',
      ' */',
      '',
    ].join('\n')
    expect(css.slice(0, header.length)).toBe(header)
    const google = parseCss2(css2('knutssonsbil')).filter((f) => f.subset === 'latin' || f.subset === 'latin-ext')
    const local = parseCss2Local(css.slice(header.length))
    expect(local).toHaveLength(google.length)
    const byPath = new Map(plan.fontFiles.map((f) => [f.path, f.bytes]))
    google.forEach((g, i) => {
      const l = local[i]!
      expect(l.subset).toBe(g.subset)
      expect(l.block).toBe(g.block.replace(g.src, l.src))
      expect(l.src).toMatch(/^\/fonts\//)
      // The local file holds exactly the bytes Google served for that face.
      expect(Buffer.from(byPath.get(`public${l.src}`)!).toString()).toBe(Buffer.from(fakeWoff2(g.src)).toString())
    })
    // Oswald is variable: its four weights share one file per subset.
    expect(plan.fontFiles.filter((f) => f.path.startsWith('public/fonts/oswald-'))).toHaveLength(2)
    expect(plan.fontFiles.map((f) => f.path).filter((p) => p.startsWith('public/fonts/oswald-')).every((p) => p.includes('-400_700-'))).toBe(true)
    expect(plan.fontFiles).toHaveLength(new Set(google.map((g) => g.src)).size)
    expect(plan.newFiles.map((f) => f.path).sort()).toEqual(['public/fonts/LICENSE-barlow.txt', 'public/fonts/LICENSE-oswald.txt', 'src/styles/fonts.css'])
    expect(plan.newFiles.find((f) => f.path === 'public/fonts/LICENSE-oswald.txt')!.text).toBe(licenceText('oswald'))
    expect(css.endsWith('}\n')).toBe(true)
  })

  test('every face keeps font-display: swap (added where Google left it out)', async () => {
    const files = CASES['ljrevision']!()
    const noSwap = css2('figtree').replaceAll('  font-display: swap;\n', '')
    const plan = ok(await planFonts(files, reportOf(files), { fetch: network({ [URLS.figtree]: text(noSwap, 'text/css') }), now: DATE }))
    const css = plan.newFiles.find((f) => f.path === 'src/styles/fonts.css')!.text
    expect(css.match(/@font-face/g)).toHaveLength(10)
    expect(css.match(/font-display: swap;/g)).toHaveLength(10)
  })

  test('an arrow in the site\'s text keeps the subset that has it, and says why in the header', async () => {
    const files = withFiles(CASES['arjangs-elmontage']!(), { 'src/pages/index.astro': '<a href="/kontakt">Kontakta oss →</a>\n' })
    const plan = ok(await planFonts(files, reportOf(files), { fetch: network(), now: DATE }))
    const css = plan.newFiles.find((f) => f.path === 'src/styles/fonts.css')!.text
    expect(css).toContain(' * Subsets: latin, latin-ext, math (U+2192), symbols (U+2192).')
    expect(plan.fontFiles.some((f) => f.path.startsWith('public/fonts/open-sans-normal-400_700-symbols-'))).toBe(true)
  })

  test('the plan is deterministic: the same inputs give the same plan', async () => {
    const files = CASES['ernstedt']!()
    const a = await planFonts(files, reportOf(files), { fetch: network(), now: DATE })
    const b = await planFonts(files, reportOf(files), { fetch: network(), now: DATE })
    expect(a).toEqual(b)
  })

  test('the css entry gets the import relative to its own folder', async () => {
    const base = CASES['knutssonsbil']!()
    const files = withFiles(base, { 'src/global.css': base.read(ENTRY), [ENTRY]: null, 'src/layouts/Base.astro': base.read('src/layouts/Base.astro').replace('../styles/global.css', '../global.css') })
    const plan = ok(await planFonts(files, reportOf(files, 'src/global.css'), { fetch: network(), now: DATE }))
    expect(applyEdits(files.read('src/global.css'), plan.edits.filter((e) => e.file === 'src/global.css'))).toBe('@import "tailwindcss";\n@import "./styles/fonts.css";\n@plugin "daisyui";\n')
  })

  test('a Google Fonts comment right above the links goes with them; a blank line between keeps it', async () => {
    const base = CASES['knutssonsbil']!()
    const layout = base.read('src/layouts/Base.astro')
    const commented = layout.replace('    <link rel="preconnect" href="https://fonts.googleapis.com" />', '\n    <!-- Google Fonts: Oswald (headings) + Barlow (body) -->\n    <link rel="preconnect" href="https://fonts.googleapis.com" />')
    const files = withFiles(base, { 'src/layouts/Base.astro': `${commented.replace('  </head>', '\n  </head>')}` })
    const plan = ok(await planFonts(files, reportOf(files), { fetch: network(), now: DATE }))
    const out = applyEdits(files.read('src/layouts/Base.astro'), plan.edits.filter((e) => e.file === 'src/layouts/Base.astro'))
    expect(out).toContain('    <link rel="icon" href="/favicon.webp" />\n\n  </head>')
    expect(out).not.toContain('Google Fonts')

    const apart = layout.replace('    <link rel="preconnect" href="https://fonts.googleapis.com" />', '    <!-- Site icons -->\n\n    <link rel="preconnect" href="https://fonts.googleapis.com" />')
    const files2 = withFiles(base, { 'src/layouts/Base.astro': apart })
    const plan2 = ok(await planFonts(files2, reportOf(files2), { fetch: network(), now: DATE }))
    const out2 = applyEdits(apart, plan2.edits.filter((e) => e.file === 'src/layouts/Base.astro'))
    expect(out2).toContain('<!-- Site icons -->\n  </head>')
  })
})

/** fonts.css after its header: each `/* subset *\/` + @font-face block, with its local url. */
function parseCss2Local(css: string): { subset: string; block: string; src: string }[] {
  return [...css.matchAll(/\/\* ([\w-]+) \*\/\n(@font-face \{[^}]*\})/g)].map((m) => ({
    subset: m[1]!,
    block: m[2]!,
    src: /url\(([^)]+)\)/.exec(m[2]!)![1]!,
  }))
}

// ── refusals: nothing planned, nothing written ───────────────────────────────────────────────

describe('planFonts refuses, with nothing planned', () => {
  const knut = (): SiteFiles => CASES['knutssonsbil']!()

  test('a report from before fonts detection: run detect again; no request is made', async () => {
    const net = network()
    const plan = await planFonts(knut(), { css: { entry: ENTRY } }, { fetch: net, now: DATE })
    expect(plan).toEqual({ ok: false, refusals: [{ file: '', target: 'google fonts', reason: expect.stringMatching(/run detect again/) }] })
    expect(net.calls).toEqual([])
  })

  test('status needs-human (its reasons), none and self-hosted (nothing to do); no request is made', async () => {
    const net = network()
    const files = knut()
    const base = reportOf(files)
    await refused(files, net, 'needs a look', { ...base, fonts: { ...base.fonts, status: 'needs-human', url: null, reasons: ['src/x.ts: Google Fonts host mentioned'] } })
    await refused(files, net, 'src/x.ts: Google Fonts host mentioned', { ...base, fonts: { ...base.fonts, status: 'needs-human', url: null, reasons: ['src/x.ts: Google Fonts host mentioned'] } })
    await refused(files, net, /no Google Fonts to self-host \(status none\)/, { ...base, fonts: { status: 'none', url: null, urls: [], locations: [], csp: [], reasons: [] } })
    await refused(files, net, /status self-hosted/, { ...base, fonts: { status: 'self-hosted', url: null, urls: [], locations: [], csp: [], reasons: [] } })
    expect(net.calls).toEqual([])
  })

  test('src/styles/fonts.css or anything in public/fonts/ already there', async () => {
    const files = knut()
    const report = reportOf(files)
    await refused(withFiles(files, { 'src/styles/fonts.css': '' }), network(), 'src/styles/fonts.css already exists', report)
    await refused(withFiles(files, { 'public/fonts/a.woff2': 'x' }), network(), 'public/fonts/ already exists', report)
  })

  test('the css2 request fails, answers 404, or answers without @font-face', async () => {
    const files = knut()
    await refused(files, network({ [URLS.knutssonsbil]: new Error('getaddrinfo ENOTFOUND fonts.googleapis.com') }), /fonts\.googleapis\.com\/css2.*ENOTFOUND/)
    await refused(files, network({ [URLS.knutssonsbil]: text('nope', 'text/html', 404) }), /answered 404/)
    await refused(files, network({ [URLS.knutssonsbil]: text('<!doctype html><p>Sorry</p>', 'text/html') }), /no @font-face/)
  })

  test('a response with truetype faces (what an old User-Agent gets) or without latin', async () => {
    const files = knut()
    const ttf = css2('knutssonsbil').replaceAll(".woff2) format('woff2')", ".ttf) format('truetype')")
    await refused(files, network({ [URLS.knutssonsbil]: text(ttf, 'text/css') }), /woff2/)
    const noLatin = css2('knutssonsbil').replace(/\/\* latin \*\/\n@font-face \{[^}]*\}\n/g, '')
    await refused(files, network({ [URLS.knutssonsbil]: text(noLatin, 'text/css') }), /no latin subset/)
  })

  test('a woff2 download fails, answers 500, or is not a woff2', async () => {
    const files = knut()
    const first = parseCss2(css2('knutssonsbil')).find((f) => f.subset === 'latin')!.src
    await refused(files, network({ [first]: new Error('socket hang up') }), /socket hang up/)
    await refused(files, network({ [first]: { status: 500, contentType: 'text/html', body: new Uint8Array() } }), /answered 500/)
    await refused(files, network({ [first]: text('<html>', 'text/html') }), /not a woff2/)
  })

  test('a family whose licence is in none of ofl/, apache/, ufl/, or whose licence request fails', async () => {
    const files = knut()
    const [ofl] = licenceUrls('Oswald')
    await refused(files, network({ [ofl!.url]: text('404: Not Found', 'text/plain', 404) }), /no licence for Oswald in google\/fonts/)
    await refused(files, network({ [ofl!.url]: text('oops', 'text/plain', 500) }), /answered 500/)
    await refused(files, network({ [ofl!.url]: text('Hello', 'text/plain') }), /not the OFL/)
  })

  test('an Apache family gets its LICENSE.txt', async () => {
    const files = knut()
    const [ofl, apache] = licenceUrls('Barlow')
    const plan = ok(
      await planFonts(files, reportOf(files), {
        fetch: network({ [ofl!.url]: text('404', 'text/plain', 404), [apache!.url]: text('                                 Apache License\n                           Version 2.0, January 2004\n') }),
        now: DATE,
      }),
    )
    expect(plan.newFiles.find((f) => f.path === 'public/fonts/LICENSE-barlow.txt')!.text).toContain('Apache License')
    expect(plan.newFiles.find((f) => f.path === 'src/styles/fonts.css')!.text).toContain('/fonts/LICENSE-barlow.txt (Apache-2.0)')
  })

  test('a CSP directive that would be left with no source', async () => {
    const base = knut()
    const layout = base.read('src/layouts/Base.astro').replace(
      '    <link rel="icon"',
      `    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src https://fonts.gstatic.com" />\n    <link rel="icon"`,
    )
    const files = withFiles(base, { 'src/layouts/Base.astro': layout })
    expect(reportOf(files).fonts.status).toBe('wire')
    await refused(files, network(), /connect-src would be left with no source/)
  })

  test('a css entry without @import "tailwindcss"', async () => {
    const files = withFiles(knut(), { [ENTRY]: '@plugin "daisyui";\n' })
    await refused(files, network(), /@import "tailwindcss"/, { ...reportOf(knut()), css: { entry: ENTRY } })
  })
})

// ── on disk: run.ts fonts and wire ───────────────────────────────────────────────────────────

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function writeTree(dir: string, tree: Map<string, string>): void {
  for (const [path, t] of tree) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), t)
  }
}
/** A clone of a bare origin whose main holds `tree`. */
function checkout(tree: Map<string, string>): string {
  const origin = temp('fonts-origin-')
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = temp('fonts-seed-')
  git(seed, 'init', '-q', '-b', 'main')
  writeTree(seed, tree)
  git(seed, 'add', '-A')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.se', 'commit', '-q', '-m', 'site')
  git(seed, 'push', '-q', origin, 'main')
  const parent = temp('fonts-clone-')
  git(parent, 'clone', '-q', origin, 'site')
  const dir = join(parent, 'site')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@example.se')
  return dir
}
/** A minimal wireable site: knutssonsbil's layout and entry, plus what detect needs. */
function knutTree(): Map<string, string> {
  return new Map([
    ...treeOf(join(FIXTURES, 'fonts', 'knutssonsbil')),
    ['package.json', JSON.stringify({ dependencies: { astro: '^6.1.6' } })],
    ['astro.config.mjs', "import { defineConfig } from 'astro/config'\nexport default defineConfig({})\n"],
  ])
}
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all')

describe('run.ts fonts', () => {
  test('parseFontsArgs: a dir and an optional --dry-run', () => {
    expect(parseFontsArgs(['site'])).toEqual({ dir: 'site', dryRun: false })
    expect(parseFontsArgs(['--dry-run', 'site'])).toEqual({ dir: 'site', dryRun: true })
    expect(() => parseFontsArgs([])).toThrow(/usage/)
    expect(() => parseFontsArgs(['site', '--force'])).toThrow(/--force/)
    expect(() => parseFontsArgs(['a', 'b'])).toThrow(/one site dir/)
  })

  test('constants: the branch and the commit message', () => {
    expect(FONTS_BRANCH).toBe('fonts-selfhost')
    expect(FONTS_COMMIT_MESSAGE).toBe('feat: Google Fonts från sajten själv (self-hosted)')
  })

  test('--dry-run prints the diff and the new files, and writes nothing', async () => {
    const dir = checkout(knutTree())
    runDetect(dir, ['knutssonsbil.se'])
    const { code, output } = await runFonts(dir, { dryRun: true, fetch: network(), now: DATE })
    expect(code).toBe(0)
    expect(output).toContain('--- a/src/layouts/Base.astro')
    expect(output).toContain('-    <link rel="preconnect" href="https://fonts.googleapis.com" />')
    expect(output).toContain('+@import "./fonts.css";')
    expect(output).toContain('+++ b/src/styles/fonts.css')
    expect(output).toMatch(/new +public\/fonts\/oswald-normal-400_700-latin-[0-9a-f]{8}\.woff2 \(\d+ bytes\)/)
    expect(output).toMatch(/new +public\/fonts\/LICENSE-oswald\.txt/)
    expect(status(dir)).toBe('')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
  })

  test('commits everything on fonts-selfhost from origin/main, one commit, nothing else changed', async () => {
    const dir = checkout(knutTree())
    runDetect(dir, ['knutssonsbil.se'])
    const net = network()
    const { code, output } = await runFonts(dir, { dryRun: false, fetch: net, now: DATE })
    expect(code).toBe(0)
    expect(output).toContain(`committed on ${FONTS_BRANCH}`)
    expect(git(dir, 'branch', '--show-current')).toBe(FONTS_BRANCH)
    expect(git(dir, 'rev-parse', 'HEAD~1')).toBe(git(dir, 'rev-parse', 'origin/main'))
    expect(git(dir, 'log', '-1', '--format=%s')).toBe(FONTS_COMMIT_MESSAGE)
    expect(status(dir)).toBe('')
    const changed = git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n')
    expect(changed.filter((p) => !p.startsWith('public/fonts/')).sort()).toEqual(['src/layouts/Base.astro', 'src/styles/fonts.css', 'src/styles/global.css'])
    expect(readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')).toBe(treeOf(join(WIRE, 'expected', 'knutssonsbil')).get('src/layouts/Base.astro'))
    // The woff2 files are written byte for byte.
    const woff2 = changed.filter((p) => p.endsWith('.woff2'))
    expect(woff2.length).toBeGreaterThan(0)
    for (const p of woff2) expect(readFileSync(join(dir, p)).subarray(0, 4).toString()).toBe('wOF2')
  })

  test('refuses (exit 3, nothing written) when the plan is refused', async () => {
    const dir = checkout(knutTree())
    runDetect(dir, ['knutssonsbil.se'])
    const { code, output } = await runFonts(dir, { dryRun: false, fetch: network({ [URLS.knutssonsbil]: new Error('offline') }), now: DATE })
    expect(code).toBe(3)
    expect(output).toContain('nothing was written')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(status(dir)).toBe('')
  })

  test('an existing fonts-selfhost branch, locally or on origin, or a dirty tree: an error, nothing written', async () => {
    const dir = checkout(knutTree())
    runDetect(dir, ['knutssonsbil.se'])
    git(dir, 'branch', FONTS_BRANCH)
    await expect(runFonts(dir, { dryRun: false, fetch: network(), now: DATE })).rejects.toThrow(/fonts-selfhost already exists locally/)
    git(dir, 'push', '-q', 'origin', FONTS_BRANCH)
    git(dir, 'branch', '-D', FONTS_BRANCH)
    await expect(runFonts(dir, { dryRun: false, fetch: network(), now: DATE })).rejects.toThrow(/origin already has a fonts-selfhost branch/)
    expect(status(dir)).toBe('')

    const dirty = checkout(knutTree())
    runDetect(dirty, ['knutssonsbil.se'])
    writeFileSync(join(dirty, 'stray.txt'), 'x')
    await expect(runFonts(dirty, { dryRun: false, fetch: network(), now: DATE })).rejects.toThrow(/not clean/)
    expect(existsSync(join(dirty, 'public/fonts'))).toBe(false)
  })
})

describe('run.ts wire: fonts as a second commit on consent-banner', () => {
  const ASPOMAD_URL = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@100;200;300;400&family=Poppins:wght@300;400&display=swap'
  // aspomad's own response is not recorded; Figtree's stands in (the families do not matter here).
  const aspomadNet = (over: Record<string, Answer | Error> = {}) => network(over, { [ASPOMAD_URL]: css2('figtree') })
  const aspomad = (): string => checkout(treeOf(join(FIXTURES, 'aspomad', 'before')))

  test('parseWireArgs: --no-fonts', () => {
    expect(parseWireArgs(['site', '--no-fonts'])).toEqual({ dir: 'site', dryRun: false, fonts: false })
    expect(parseWireArgs(['--dry-run', 'site'])).toEqual({ dir: 'site', dryRun: true })
  })

  test('two commits: the banner exactly as before, then the fonts commit with only the fonts paths', async () => {
    const dir = aspomad()
    const report = runDetect(dir, ['aspomad.se'])
    expect(report.fonts?.status).toBe('wire')
    const { code, output } = await runWire(dir, { dryRun: false, fetch: aspomadNet(), now: DATE, install: () => {} })
    expect(code).toBe(0)
    expect(output).toContain(`committed on ${BRANCH} (2 commits)`)
    expect(git(dir, 'branch', '--show-current')).toBe(BRANCH)
    expect(git(dir, 'log', '-2', '--format=%s').split('\n')).toEqual([FONTS_COMMIT_MESSAGE, COMMIT_MESSAGE])
    expect(git(dir, 'rev-parse', 'HEAD~2')).toBe(git(dir, 'rev-parse', 'origin/main'))
    // The banner commit is the banner wiring alone: expected/ of the pilot fixture.
    const expected = treeOf(join(FIXTURES, 'aspomad', 'expected'))
    for (const [path, want] of expected) expect(execFileSync('git', ['show', `HEAD~1:${path}`], { cwd: dir, encoding: 'utf8' }), path).toBe(want)
    const fontsPaths = git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n')
    expect(fontsPaths.filter((p) => !p.startsWith('public/fonts/')).sort()).toEqual(['src/layouts/Base.astro', 'src/styles/fonts.css', 'src/styles/global.css'])
    const layout = readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')
    expect(layout).not.toContain('fonts.g')
    expect(layout).toContain('<ConsentBanner />')
    const css = readFileSync(join(dir, 'src/styles/global.css'), 'utf8')
    expect(css.startsWith('@import "tailwindcss";\n@import "./fonts.css";\n@plugin "daisyui";\n@source ')).toBe(true)
    expect(status(dir)).toBe('')
  })

  test('--no-fonts: one commit, no request to Google', async () => {
    const dir = aspomad()
    runDetect(dir, ['aspomad.se'])
    const net = aspomadNet()
    const { code } = await runWire(dir, { dryRun: false, fonts: false, fetch: net, install: () => {} })
    expect(code).toBe(0)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe(COMMIT_MESSAGE)
    expect(net.calls).toEqual([])
  })

  test('a refused fonts plan refuses the whole wire (exit 3, nothing written) and names --no-fonts', async () => {
    const dir = aspomad()
    runDetect(dir, ['aspomad.se'])
    const { code, output } = await runWire(dir, { dryRun: false, fetch: aspomadNet({ [ASPOMAD_URL]: new Error('offline') }), install: () => {} })
    expect(code).toBe(3)
    expect(output).toContain('--no-fonts')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(status(dir)).toBe('')
  })

  test('--dry-run shows the banner diff and the fonts diff, writes nothing', async () => {
    const dir = aspomad()
    runDetect(dir, ['aspomad.se'])
    const { code, output } = await runWire(dir, { dryRun: true, fetch: aspomadNet(), now: DATE })
    expect(code).toBe(0)
    expect(output).toContain("+import ConsentBanner from '@visionmediahq/astro-consent/components/ConsentBanner.astro'")
    expect(output).toContain('+++ b/src/styles/fonts.css')
    expect(output).toContain('+@import "./fonts.css";')
    expect(status(dir)).toBe('')
  })
})
