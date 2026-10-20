// `fonts-files`: the Google Fonts self-hosting of `wire`/`fonts` without detect, git or any edit to
// the site's markup, for sites that are generated rather than rolled out (site-factory#175). Every
// answer is recorded (fixtures/fonts-wire/css2/, fake woff2, stand-in licences); nothing reaches
// the network.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectFonts } from '../../../ci/rollout/detect/fonts'
import { fixtureSite } from '../../../ci/rollout/lib/site-files'
import { main as runMain } from '../../../ci/rollout/run'
import { main, parseFontsFilesArgs, runFontsFiles } from '../../../ci/rollout/fonts-files'
import { parseCss2 } from '../../../ci/rollout/wire/fonts-css'
import { CHROME_UA, type FontFetch, planFonts } from '../../../ci/rollout/wire/fonts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const ENTRY = 'src/styles/global.css'
const DATE = new Date('2026-10-20T12:00:00Z')
const URL_KNUT = 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Barlow:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap'
const CSS_V1 = readFileSync(join(FIXTURES, 'fonts-wire/css2/css1-oswald-lato.css.txt'), 'utf8')
const CSS_KNUT = readFileSync(join(FIXTURES, 'fonts-wire/css2/knut.css.txt'), 'utf8')

interface Answer {
  status: number
  contentType: string
  body: Uint8Array
}
const text = (s: string, contentType = 'text/plain; charset=utf-8', status = 200): Answer => ({ status, contentType, body: new TextEncoder().encode(s) })
const fakeWoff2 = (url: string): Uint8Array => new TextEncoder().encode(`wOF2\u0000${createHash('sha256').update(url).digest('hex').slice(0, 16)}`)

function network(over: Record<string, Answer | Error> = {}): FontFetch & { calls: string[] } {
  const calls: string[] = []
  const fetch = async (url: string, headers: Record<string, string>): Promise<Answer> => {
    calls.push(url)
    const o = over[url]
    if (o instanceof Error) throw o
    if (o) return o
    if (url === URL_KNUT) {
      expect(headers['User-Agent']).toBe(CHROME_UA)
      return text(CSS_KNUT, 'text/css; charset=utf-8')
    }
    if (/^https:\/\/fonts\.gstatic\.com\/.+\.woff2$/.test(url)) return { status: 200, contentType: 'font/woff2', body: fakeWoff2(url) }
    const ofl = /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/main\/ofl\/([a-z0-9]+)\/OFL\.txt$/.exec(url)
    if (ofl) return text(`Copyright 2020 The ${ofl[1]} Project Authors\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n`)
    return text('404: Not Found', 'text/plain', 404)
  }
  return Object.assign(fetch, { calls })
}

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A generated site on disk: knutssonsbil's layout and stylesheet, the way the Builder leaves them. */
function generatedSite(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fonts-files-'))
  temps.push(dir)
  const src = join(FIXTURES, 'fonts/knutssonsbil')
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.name.endsWith('.txt')) put(dir, relative(src, full).split(sep).join('/').slice(0, -4), readFileSync(full, 'utf8'))
    }
  }
  visit(src)
  for (const [p, t] of Object.entries(extra)) put(dir, p, t)
  return dir
}
function put(dir: string, path: string, data: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), data)
}
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) visit(full)
      else out.set(relative(dir, full).split(sep).join('/'), readFileSync(full))
    }
  }
  visit(dir)
  return out
}

describe('parseFontsFilesArgs', () => {
  test('a site dir, --url, optional --entry and --dry-run', () => {
    expect(parseFontsFilesArgs(['/s', '--url', 'https://fonts.googleapis.com/css2?family=A'])).toEqual({ dir: '/s', url: 'https://fonts.googleapis.com/css2?family=A', entry: null, dryRun: false })
    expect(parseFontsFilesArgs(['--dry-run', '/s', '--url=u', '--entry', ENTRY])).toEqual({ dir: '/s', url: 'u', entry: ENTRY, dryRun: true })
  })
  test('usage errors: no dir, no url, unknown option, two dirs, option without a value', () => {
    expect(() => parseFontsFilesArgs([])).toThrow(/usage/)
    expect(() => parseFontsFilesArgs(['/s'])).toThrow(/--url/)
    expect(() => parseFontsFilesArgs(['/s', '--url', 'u', '--nope'])).toThrow(/unknown option --nope/)
    expect(() => parseFontsFilesArgs(['/s', '/t', '--url', 'u'])).toThrow(/one site dir only/)
    expect(() => parseFontsFilesArgs(['/s', '--url'])).toThrow(/--url needs a value/)
  })
})

describe('runFontsFiles', () => {
  test('writes exactly the files wire writes for the same URL (woff2, licences, fonts.css), nothing else', async () => {
    const dir = generatedSite()
    const before = tree(dir)
    const { code, output } = await runFontsFiles({ dir, url: URL_KNUT, entry: null, dryRun: false }, { fetch: network(), now: DATE })
    expect(code).toBe(0)
    const after = tree(dir)
    const added = [...after.keys()].filter((k) => !before.has(k))
    expect(added.some((p) => p === 'src/styles/fonts.css')).toBe(true)
    expect(added.every((p) => p === 'src/styles/fonts.css' || p.startsWith('public/fonts/'))).toBe(true)
    for (const [k, v] of before) expect(after.get(k)!.equals(v)).toBe(true)
    expect(output).toContain('src/styles/fonts.css')

    // Reference: the rollout's own plan for the same site and URL.
    const files = fixtureSite(join(FIXTURES, 'fonts/knutssonsbil'))
    const plan = await planFonts(files, { fonts: detectFonts(files, ENTRY), css: { entry: ENTRY } }, { fetch: network(), now: DATE })
    if (!plan.ok) throw new Error('reference plan refused')
    expect(plan.url).toBe(URL_KNUT)
    for (const f of plan.newFiles) expect(after.get(f.path)!.toString('utf8')).toBe(f.text)
    for (const f of plan.fontFiles) expect(after.get(f.path)!.equals(Buffer.from(f.bytes))).toBe(true)
    expect(added.length).toBe(plan.newFiles.length + plan.fontFiles.length)
  })

  test('the generated stylesheet keeps the face names, weights and unicode-ranges and no Google host outside the header', async () => {
    const dir = generatedSite()
    await runFontsFiles({ dir, url: URL_KNUT, entry: null, dryRun: false }, { fetch: network(), now: DATE })
    const css = readFileSync(join(dir, 'src/styles/fonts.css'), 'utf8')
    expect(css).toContain(`Generated from ${URL_KNUT}`)
    expect(css).toContain('on 2026-10-20')
    expect(css).toContain("font-family: 'Oswald'")
    expect(css).toContain('font-display: swap')
    expect(css).toContain('unicode-range')
    expect(css.replace(/^\/\*[\s\S]*?\*\/\n/, '')).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(css).toMatch(/url\(\/fonts\/[a-z0-9-]+\.woff2\)/)
  })

  test('a css v1 URL (family=A:400,700|B:300), which Scout records from older sites, is accepted: same faces', async () => {
    const v1 = 'https://fonts.googleapis.com/css?family=Oswald:400,700|Lato:300,400i&display=swap'
    const dir = generatedSite()
    const net = network({ [v1]: text(CSS_V1, 'text/css; charset=utf-8') })
    const { code } = await runFontsFiles({ dir, url: v1, entry: null, dryRun: false }, { fetch: net, now: DATE })
    expect(code).toBe(0)
    const css = readFileSync(join(dir, 'src/styles/fonts.css'), 'utf8')
    expect(css).toContain("font-family: 'Lato'")
    expect(css).toContain('font-style: italic')
    expect(existsSync(join(dir, 'public/fonts/LICENSE-lato.txt'))).toBe(true)
  })

  test('--entry adds the @import after @import "tailwindcss" and edits nothing else', async () => {
    const dir = generatedSite()
    const entry = readFileSync(join(dir, ENTRY), 'utf8')
    const layout = readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')
    const { code } = await runFontsFiles({ dir, url: URL_KNUT, entry: ENTRY, dryRun: false }, { fetch: network(), now: DATE })
    expect(code).toBe(0)
    const now = readFileSync(join(dir, ENTRY), 'utf8')
    expect(now.replace('\n@import "./fonts.css";', '')).toBe(entry)
    expect(now.indexOf('@import "tailwindcss"')).toBeLessThan(now.indexOf('@import "./fonts.css";'))
    // The layout keeps whatever it had: this command never cuts markup (the Builder writes none).
    expect(readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')).toBe(layout)
  })

  test('without --entry the stylesheet entry is untouched', async () => {
    const dir = generatedSite()
    const entry = readFileSync(join(dir, ENTRY), 'utf8')
    await runFontsFiles({ dir, url: URL_KNUT, entry: null, dryRun: false }, { fetch: network(), now: DATE })
    expect(readFileSync(join(dir, ENTRY), 'utf8')).toBe(entry)
  })

  test('--dry-run fetches but writes nothing, and says what it would write', async () => {
    const dir = generatedSite()
    const before = tree(dir)
    const { code, output } = await runFontsFiles({ dir, url: URL_KNUT, entry: ENTRY, dryRun: true }, { fetch: network(), now: DATE })
    expect(code).toBe(0)
    expect([...tree(dir).keys()]).toEqual([...before.keys()])
    expect(output).toMatch(/dry run/i)
    expect(output).toContain('src/styles/fonts.css')
  })

  test('subsets follow the site text: Cyrillic in src/ keeps the cyrillic faces', async () => {
    const plain = generatedSite()
    await runFontsFiles({ dir: plain, url: URL_KNUT, entry: null, dryRun: false }, { fetch: network(), now: DATE })
    const russian = generatedSite({ 'src/pages/index.astro': '<h1>Привет</h1>\n' })
    await runFontsFiles({ dir: russian, url: URL_KNUT, entry: null, dryRun: false }, { fetch: network(), now: DATE })
    expect(readFileSync(join(russian, 'src/styles/fonts.css'), 'utf8')).toContain('/* cyrillic */')
    expect(readFileSync(join(plain, 'src/styles/fonts.css'), 'utf8')).not.toContain('/* cyrillic */')
  })

  describe('refusals write nothing and exit 3', () => {
    const refusal = async (dir: string, url: string, fetch: FontFetch, entry: string | null = ENTRY) => {
      const before = tree(dir)
      const r = await runFontsFiles({ dir, url, entry, dryRun: false }, { fetch, now: DATE })
      expect(r.code).toBe(3)
      const after = tree(dir)
      expect([...after.keys()]).toEqual([...before.keys()])
      for (const [k, v] of before) expect(after.get(k)!.equals(v)).toBe(true)
      return r.output
    }
    test('a URL that is not a css2 URL: no request is made', async () => {
      const net = network()
      expect(await refusal(generatedSite(), 'https://example.com/a.css', net)).toContain('not a Google Fonts css/css2 URL')
      expect(net.calls).toEqual([])
    })
    test('the stylesheet or the folder is already there', async () => {
      expect(await refusal(generatedSite({ 'src/styles/fonts.css': '/* x */' }), URL_KNUT, network())).toContain('src/styles/fonts.css already exists')
      expect(await refusal(generatedSite({ 'public/fonts/a.woff2': 'x' }), URL_KNUT, network())).toContain('public/fonts/ already exists')
    })
    test('an entry without @import "tailwindcss", or one that is missing', async () => {
      const noTw = generatedSite({ [ENTRY]: 'body { color: red }\n' })
      expect(await refusal(noTw, URL_KNUT, network())).toContain('expected exactly 1')
      expect(await refusal(generatedSite(), URL_KNUT, network(), 'src/styles/nope.css')).toContain('src/styles/nope.css')
    })
    test('a failed request, an HTML answer, a file that is not woff2', async () => {
      expect(await refusal(generatedSite(), URL_KNUT, network({ [URL_KNUT]: new Error('getaddrinfo ENOTFOUND') }))).toContain('ENOTFOUND')
      expect(await refusal(generatedSite(), URL_KNUT, network({ [URL_KNUT]: text('<p>Sorry</p>', 'text/html') }))).toContain('no @font-face')
      const first = parseCss2(CSS_KNUT).find((f) => f.subset === 'latin')!.src
      expect(await refusal(generatedSite(), URL_KNUT, network({ [first]: text('not a font', 'font/woff2') }))).toContain('not a woff2 file')
    })
    test('no licence in google/fonts', async () => {
      const net = network()
      const bad: FontFetch = async (url, h) => (/\/ofl\/oswald\/OFL\.txt$/.test(url) ? text('nope', 'text/plain', 404) : net(url, h))
      expect(await refusal(generatedSite(), URL_KNUT, bad)).toContain('no licence for Oswald')
    })
  })
})

describe('main', () => {
  test('usage errors exit 2 and need no network', async () => {
    expect(await main([])).toBe(2)
    expect(await main(['/nowhere'])).toBe(2)
    expect(await main(['/nowhere', '--url', 'u', '--bogus'])).toBe(2)
  })
  test('a site dir that does not exist exits 1', async () => {
    expect(await main(['/nonexistent-site-dir', '--url', URL_KNUT])).toBe(1)
  })
})

// The Builder runs this file with nothing but tsx and node (no npm install of this repo), so
// everything it imports must be node built-ins or files that are themselves that.
describe('standalone', () => {
  test('the import closure of fonts-files.ts is relative files and node: built-ins only', () => {
    const seen = new Set<string>()
    const bare: string[] = []
    const visit = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/^(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1]!
        if (/^import\s+type\b|^export\s+type\b/.test(m[0])) continue
        if (spec.startsWith('node:')) continue
        if (spec.startsWith('.')) {
          const base = join(dirname(file), spec)
          visit(existsSync(`${base}.ts`) ? `${base}.ts` : join(base, 'index.ts'))
        } else bare.push(`${relative(process.cwd(), file)}: ${spec}`)
      }
    }
    visit(join(import.meta.dirname, '../../../ci/rollout/fonts-files.ts'))
    expect(bare).toEqual([])
    expect(seen.size).toBeGreaterThan(2)
    expect([...seen].map((f) => relative(join(import.meta.dirname, '../../..'), f))).not.toContain('ci/rollout/wire/index.ts')
  })
})

test('run.ts routes fonts-files to the same command (usage error: exit 2)', async () => {
  expect(await runMain(['fonts-files'])).toBe(2)
  expect(await runMain(['fonts-files', '/nowhere'])).toBe(2)
})
