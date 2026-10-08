import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contrastRows, coversBackground, measureContrast, type RawContrast } from '../../../ci/rollout/checks/contrast'
import { extractLinks, listPages, MISSING_PREFIX } from '../../../ci/rollout/checks/pages'
import { blockUmami, freshPage, isBlocked, isUmamiUrl, notRequested, umamiScriptSrcs } from '../../../ci/rollout/checks/requests'
import { wcagContrast } from '../../../ci/rollout/lib/colour'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function dist(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'checks-'))
  dirs.push(dir)
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), '<html></html>')
  }
  return dir
}

describe('listPages', () => {
  it('static: every built page plus a missing URL for the 404 page', async () => {
    const distDir = dist(['index.html', 'om/index.html', '404.html', '_astro/x.css'])
    const pages = await listPages('http://127.0.0.1:4321', { distDir, ssr: false })
    expect(pages.slice(0, 2)).toEqual(['/', '/om/'])
    expect(pages).toHaveLength(3)
    expect(pages[2]).toMatch(new RegExp(`^${MISSING_PREFIX}[a-z0-9]+$`))
    expect(MISSING_PREFIX).toBe('/finns-inte-')
  })

  it('static: build.format "file" pages keep their file path without .html', async () => {
    const distDir = dist(['index.html', 'kontakt.html', 'tjanster/bygg.html'])
    const pages = await listPages('http://127.0.0.1:4321', { distDir, ssr: false })
    expect(pages.slice(0, 3)).toEqual(['/', '/kontakt', '/tjanster/bygg'])
  })

  it('finding 12: static output with an adapter (dist/client + dist/server/entry.mjs) lists dist/client, not /client/…', async () => {
    const distDir = dist(['client/index.html', 'client/om/index.html', 'client/admin/index.html', 'client/404.html', 'server/entry.mjs'])
    const pages = await listPages('http://127.0.0.1:4321', { distDir, ssr: false })
    expect(pages.slice(0, -1)).toEqual(['/', '/admin/', '/om/'])
  })

  it('finding 12: without dist/server/entry.mjs a page folder named client is just a page', async () => {
    const distDir = dist(['index.html', 'client/index.html'])
    const pages = await listPages('http://127.0.0.1:4321', { distDir, ssr: false })
    expect(pages.slice(0, -1)).toEqual(['/', '/client/'])
  })

  it('static: requires a dist dir', async () => {
    await expect(listPages('http://127.0.0.1:4321', { ssr: false })).rejects.toThrow(/distDir/)
  })
})

describe('extractLinks (ssr crawl)', () => {
  const base = 'https://exempel.se'
  it('keeps only same-origin page paths, deduped, without hash or query', () => {
    const html = `
      <a href="/om">Om</a>
      <a href="/om#team">Om igen</a>
      <a href="https://exempel.se/kontakt/?x=1">Kontakt</a>
      <a href="tjanster">Relativ</a>
      <a href="https://annan.se/om">Extern</a>
      <a href="//cdn.exempel.net/a">Protokollrelativ extern</a>
      <a href="mailto:info@exempel.se">Mejl</a>
      <a href="tel:+46123">Ring</a>
      <a href="#top">Upp</a>
      <a href="javascript:void(0)">JS</a>
      <a href="/broschyr.pdf">PDF</a>
      <a>Ingen href</a>`
    expect(extractLinks(html, `${base}/sida/`, base)).toEqual(['/om', '/kontakt/', '/sida/tjanster'])
  })
})

describe('isBlocked', () => {
  it('uses the registry patterns from src/services.ts', () => {
    expect(isBlocked('https://maps.googleapis.com/maps/api/js?key=x')).toBe(true)
    expect(isBlocked('https://www.google.com/maps/embed?pb=1')).toBe(true)
    expect(isBlocked('https://connect.facebook.net/en_US/fbevents.js')).toBe(true)
    expect(isBlocked('https://cloud.umami.is/script.js')).toBe(false)
    expect(isBlocked('https://exempel.se/')).toBe(false)
  })
})

describe('notRequested (registry URLs in the DOM)', () => {
  it('reports registry URLs present in the DOM but never requested, resolved and deduped', () => {
    const dom = [
      'https://www.google.com/maps/embed?pb=lazy',
      'https://www.google.com/maps/embed?pb=lazy',
      'https://maps.googleapis.com/maps/api/js',
      'https://exempel.se/bild.jpg',
    ]
    const requested = ['https://maps.googleapis.com/maps/api/js']
    expect(notRequested(dom, requested)).toEqual(['in DOM, not requested: https://www.google.com/maps/embed?pb=lazy'])
  })
})

describe('freshPage', () => {
  function fakeBrowser() {
    const calls: { options: unknown; routes: number } = { options: null, routes: 0 }
    const context = { route: async () => void calls.routes++, on: () => undefined, newPage: async () => ({}) }
    const browser = { newContext: async (options: unknown) => ((calls.options = options), context) }
    return { browser: browser as never, calls }
  }

  it('blocks service workers, which bypass context.route and request events', async () => {
    for (const stub of [true, false]) {
      const { browser, calls } = fakeBrowser()
      await freshPage(browser, stub)
      expect(calls.options).toMatchObject({ serviceWorkers: 'block' })
      // The registry stub when stub is true; the Umami block always (Ruling 38).
      expect(calls.routes).toBe(stub ? 2 : 1)
    }
  })
})

describe('Umami (finding 6, Ruling 38)', () => {
  const u = (s: string) => new URL(s)
  it('isUmamiUrl: a learned script src, any /api/send, any host or path with "umami"; nothing else', () => {
    const srcs = new Set(['https://stats.exempel.se/s.js'])
    expect(isUmamiUrl(u('https://stats.exempel.se/s.js'), srcs)).toBe(true)
    expect(isUmamiUrl(u('https://stats.exempel.se/api/send'), srcs)).toBe(true)
    expect(isUmamiUrl(u('https://exempel.se/api/send/'), new Set())).toBe(true)
    expect(isUmamiUrl(u('https://cloud.umami.is/script.js'), new Set())).toBe(true)
    expect(isUmamiUrl(u('https://exempel.se/umami/script.js'), new Set())).toBe(true)
    expect(isUmamiUrl(u('https://stats.exempel.se/other.js'), srcs)).toBe(false)
    expect(isUmamiUrl(u('https://exempel.se/api/sender'), new Set())).toBe(false)
    expect(isUmamiUrl(u('https://exempel.se/'), new Set())).toBe(false)
  })

  it('umamiScriptSrcs: the src of every script with data-website-id, resolved against the page', () => {
    const html = `<html><head>
      <script defer src="https://stats.exempel.se/s.js" data-website-id="00000000-0000-0000-0000-000000000000"></script>
      <script async data-website-id="x" src="/u/t.js"></script>
      <script src="/app.js"></script>
      <script data-website-id="y">inline()</script>
    </head></html>`
    expect(umamiScriptSrcs(html, 'https://exempel.se/om/')).toEqual(['https://stats.exempel.se/s.js', 'https://exempel.se/u/t.js'])
  })

  it('blockUmami answers Umami with an empty 204 and passes everything else on; a script waits for the page that names it', async () => {
    let handler: ((route: unknown) => Promise<void>) | null = null
    const listeners: ((r: unknown) => void)[] = []
    const context = {
      route: async (_match: unknown, h: (route: unknown) => Promise<void>) => void (handler = h),
      on: (_event: string, l: (r: unknown) => void) => void listeners.push(l),
    }
    await blockUmami(context as never)
    const answer = async (url: string, resourceType: string) => {
      const seen: string[] = []
      await handler!({
        request: () => ({ url: () => url, resourceType: () => resourceType, headers: () => ({}) }),
        fulfill: async (o: { status: number; body: string }) => void seen.push(`fulfill ${o.status} ${JSON.stringify(o.body)}`),
        fallback: async () => void seen.push('fallback'),
      })
      return seen
    }
    // The page's HTML is still downloading when the browser asks for the script.
    let finish: (html: string) => void = () => undefined
    const body = new Promise<string>((r) => (finish = r))
    for (const l of listeners) {
      l({ url: () => 'https://exempel.se/', request: () => ({ resourceType: () => 'document' }), text: () => body })
    }
    const script = answer('https://stats.exempel.se/s.js', 'script')
    finish('<script defer src="https://stats.exempel.se/s.js" data-website-id="00000000-0000-0000-0000-000000000000"></script>')
    expect(await script).toEqual(['fulfill 204 ""'])
    expect(await answer('https://exempel.se/api/send', 'fetch')).toEqual(['fulfill 204 ""'])
    expect(await answer('https://cloud.umami.is/script.js', 'script')).toEqual(['fulfill 204 ""'])
    expect(await answer('https://stats.exempel.se/other.js', 'script')).toEqual(['fallback'])
    expect(await answer('https://exempel.se/', 'document')).toEqual(['fallback'])
  })
})

describe('contrast', () => {
  const raw = (over: Partial<RawContrast>): RawContrast => ({
    kind: 'links',
    label: 'Cookie-inställningar',
    fg: [255, 255, 255, 255],
    layers: [[0, 0, 0, 255]],
    images: [],
    ...over,
  })

  it('oklab with alpha: text rasterised to rgba is blended over its background', async () => {
    // What the page's canvas returns for color: oklab(1 0 0 / 0.7) on a black footer.
    const rows = contrastRows([raw({ fg: [255, 255, 255, 179] })])
    const grey = Math.round(255 * (179 / 255))
    expect(rows[0]!.fg).toEqual({ r: grey, g: grey, b: grey })
    expect(rows[0]!.ratio).toBeCloseTo(wcagContrast({ r: grey, g: grey, b: grey }, { r: 0, g: 0, b: 0 }), 5)
    expect(rows[0]!.indeterminate).toBeUndefined()

    // measureContrast hands the page result to the same maths.
    const page = { evaluate: async () => [raw({ fg: [255, 255, 255, 179] })] }
    expect(await measureContrast(page as never)).toEqual(rows)
  })

  it('translucent backgrounds are composited over the ancestors below them', () => {
    const [row] = contrastRows([raw({ fg: [0, 0, 0, 255], layers: [[255, 0, 0, 128], [255, 255, 255, 255]] })])
    expect(row!.bg).toEqual({ r: 255, g: 127, b: 127 })
    expect(row!.ratio).toBeCloseTo(wcagContrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 127, b: 127 }), 5)
  })

  it('a background image or no opaque ancestor is indeterminate, not guessed silently', () => {
    expect(contrastRows([raw({ images: ['linear-gradient(red, blue)'] })])[0]!.indeterminate).toMatch(/image/)
    const [row] = contrastRows([raw({ fg: [0, 0, 0, 255], layers: [[0, 0, 0, 0]] })])
    expect(row!.indeterminate).toMatch(/opaque/)
    expect(row!.bg).toEqual({ r: 255, g: 255, b: 255 })
  })

  it("DaisyUI's button noise texture is decoration, not a background image", () => {
    const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Cfilter id='a'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.34' numOctaves='4' stitchTiles='stitch'%3E%3C/feTurbulence%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23a)' opacity='0.2'%3E%3C/rect%3E%3C/svg%3E")`
    expect(coversBackground(`none, ${noise}`)).toBe(false)
    expect(coversBackground('none, none')).toBe(false)
    expect(coversBackground(`url("/bg.jpg"), ${noise}`)).toBe(true)
    expect(contrastRows([raw({ images: [`none, ${noise}`] })])[0]!.indeterminate).toBeUndefined()
  })

  it('ok is ratio ≥ 4.5 and determinate: indeterminate is never a pass', () => {
    const rows = contrastRows([
      raw({}),
      raw({ fg: [119, 119, 119, 255], layers: [[255, 255, 255, 255]] }),
      raw({ images: ['url("/bg.jpg")'] }),
      raw({ layers: [] }),
    ])
    expect(rows.map((r) => r.ok)).toEqual([true, false, false, false])
    expect(rows[2]!.ratio).toBeGreaterThan(4.5)
  })

  it('labels each row with its kind and text', () => {
    const [row] = contrastRows([raw({ kind: 'banner', label: 'Neka' })])
    expect(row).toMatchObject({ kind: 'banner', button: 'Neka' })
    expect(row!.ratio).toBeCloseTo(21, 5)
  })
})
