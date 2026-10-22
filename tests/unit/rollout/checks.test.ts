import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rememberCandidates, rememberOk, type RememberCounts } from '../../../ci/rollout/checks/consent-paths'
import { diffRootStyles } from '../../../ci/rollout/checks/root-styles'
import { type BgImage, contrastRows, coversBackground, formatContrast, gradientStops, measureContrast, pendingColours, type RawContrast } from '../../../ci/rollout/checks/contrast'
import { compareEmbedHeights, type EmbedBox } from '../../../ci/rollout/checks/embed-size'
import { extractLinks, listPages, MISSING_PREFIX } from '../../../ci/rollout/checks/pages'
import { blockUmami, freshPage, isBlocked, isUmamiUrl, notRequested, umamiScriptSrcs } from '../../../ci/rollout/checks/requests'
import { type Rgb, wcagContrast } from '../../../ci/rollout/lib/colour'

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

describe('listPages (ssr crawl)', () => {
  let server: Server | undefined
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())))

  /** Serves `routes` (path → status, content type, body); anything else is a 404 page. */
  async function site(routes: Record<string, [number, string, string]>): Promise<string> {
    server = createServer((req, res) => {
      const [status, type, body] = routes[req.url ?? ''] ?? [404, 'text/html', '<html>404</html>']
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  it('a client site: a linked endpoint that answers 2xx with a file (no extension) is not a page; a broken link still is', async () => {
    const base = await site({
      '/': [200, 'text/html', '<a href="/om/">om</a> <a href="/api/blankett">blankett</a> <a href="/api/data">data</a> <a href="/borta/">borta</a>'],
      '/om/': [200, 'text/html; charset=utf-8', '<html>om</html>'],
      '/api/blankett': [200, 'application/pdf', '%PDF-1.4'],
      '/api/data': [200, 'application/json', '{}'],
    })
    const pages = await listPages(base, { ssr: true })
    expect(pages.slice(0, -1)).toEqual(['/', '/om/', '/borta/'])
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

  it('a client site: skips /cdn-cgi/, which Cloudflare reserves and answers itself (email obfuscation)', () => {
    const html = `
      <a href="/cdn-cgi/l/email-protection#a1c8cfc7cee1">Mejl</a>
      <a href="https://exempel.se/cdn-cgi/l/email-protection">Mejl igen</a>
      <a href="/om/cdn-cgi/">En sida som bara heter så</a>`
    expect(extractLinks(html, `${base}/`, base)).toEqual(['/om/cdn-cgi/'])
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
    // A visitor page whose path happens to say "umami" is the page under test, not the tracker.
    expect(await answer('https://exempel.se/meny/umami-burgare', 'document')).toEqual(['fallback'])
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
  /** A background-image on the element whose colour is layers[at] (above it), sized as a plain `background:` leaves it. */
  const img = (value: string, at = 0, more: Partial<BgImage> = {}): BgImage => ({ value, at, size: 'auto', repeat: 'repeat', position: '0% 0%', ...more })

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

  describe('the 8-bit margin on ok (#96): the ratio is reported as read, ok allows for what the page rounds', () => {
    it('a faint translucent layer: 4.53:1 as read, 4.49:1 painted, so not ok', () => {
      // #95 review, in headless Chromium: rgba(176, 41, 2, 0.07) (read back as 18/255) over
      // rgb(136, 144, 249), text #2c2c2c. Chromium paints rgb(138, 136, 231): 4.49:1.
      const [row] = contrastRows([raw({ fg: [44, 44, 44, 255], layers: [[176, 41, 2, 18], [136, 144, 249, 255]] })])
      expect(wcagContrast({ r: 44, g: 44, b: 44 }, { r: 138, g: 136, b: 231 })).toBeLessThan(4.5)
      expect(row).toMatchObject({ ok: false, bg: { r: 139, g: 137, b: 232 }, note: 'within the 8-bit margin of 4.5' })
      expect(row!.ratio).toBeCloseTo(4.534, 3)
      expect(row!.indeterminate).toBeUndefined()
    })

    it('translucent text: the page rounds the blended text colour too', () => {
      const [row] = contrastRows([raw({ fg: [255, 255, 255, 185], layers: [[0, 90, 160, 255]] })])
      expect(row).toMatchObject({ ok: false, fg: { r: 185, g: 210, b: 229 }, note: 'within the 8-bit margin of 4.5' })
      expect(row!.ratio).toBeCloseTo(4.506, 3)
    })

    it('one translucent gradient: its worst point is rounded when painted', () => {
      const stop = 'rgba(255, 255, 255, 0.24)'
      const colours: RawContrast['colours'] = { [stop]: [255, 255, 255, 61], 'rgba(255, 255, 255, 0)': [255, 255, 255, 0] }
      const [row] = contrastRows([raw({ layers: [[20, 80, 140, 255]], images: [img(`linear-gradient(${stop}, rgba(255, 255, 255, 0))`)], colours })])
      expect(row).toMatchObject({ ok: false, note: 'gradient, worst stop; within the 8-bit margin of 4.5' })
      expect(row!.ratio).toBeCloseTo(4.518, 3)
    })

    it('one opaque sRGB gradient is not exact either: Chromium dithers it, a level past a stop', () => {
      // #97 review, in headless Chromium: rows at 4.51–4.54:1 at a stop painted at 4.48–4.50.
      const [a, b] = ['rgb(0, 129, 160)', 'rgb(0, 40, 90)']
      const colours: RawContrast['colours'] = { [a]: [0, 129, 160, 255], [b]: [0, 40, 90, 255] }
      const [row] = contrastRows([raw({ images: [img(`linear-gradient(${a}, ${b})`)], colours })])
      expect(row).toMatchObject({ ok: false, note: 'gradient, worst stop; within the 8-bit margin of 4.5' })
      expect(row!.ratio).toBeCloseTo(4.518, 3)
    })

    it('a level per translucent layer: three stacked layers at 4.62:1 are not ok', () => {
      const [row] = contrastRows([raw({ fg: [99, 99, 99, 255], layers: [[255, 255, 255, 40], [200, 220, 255, 60], [240, 240, 240, 90], [210, 210, 210, 255]] })])
      expect(row).toMatchObject({ ok: false, note: 'within the 8-bit margin of 4.5' })
      expect(row!.ratio).toBeCloseTo(4.618, 3)
    })

    it('a heavy translucent layer (alpha 200/255) counts like a faint one', () => {
      const [row] = contrastRows([raw({ layers: [[142, 142, 142, 200], [30, 30, 30, 255]] })])
      expect(row).toMatchObject({ ok: false, note: 'within the 8-bit margin of 4.5' })
      expect(row!.ratio).toBeCloseTo(4.552, 3)
    })

    it('dark translucent text: its blend may round lighter', () => {
      const [row] = contrastRows([raw({ fg: [0, 0, 0, 176], layers: [[150, 150, 150, 255]] })])
      expect(row).toMatchObject({ ok: false, note: 'within the 8-bit margin of 4.5' })
      expect(row!.ratio).toBeCloseTo(4.561, 3)
    })

    it('a translucent layer beneath a translucent gradient counts too', () => {
      const stop = 'rgba(255, 255, 255, 0.1)'
      const [row] = contrastRows([
        raw({ layers: [[0, 0, 0, 0], [255, 255, 255, 60], [20, 60, 60, 255]], images: [img(`linear-gradient(${stop}, ${stop})`)], colours: { [stop]: [255, 255, 255, 26] } }),
      ])
      expect(row).toMatchObject({ ok: false, note: 'gradient, worst stop; within the 8-bit margin of 4.5' })
      // Two levels (the layer and the gradient) fail it; the gradient's alone would not.
      expect(row!.ratio).toBeCloseTo(4.68, 2)
    })

    it('opaque text on a mid-tone opaque colour, and over several gradients, gets no margin', () => {
      // Grey text and no clamp at 0 or 255 nearby, so a level anywhere would show.
      const s = 'rgb(35, 114, 140)'
      const value = `linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0)), linear-gradient(${s}, ${s})`
      const [plain, several] = contrastRows([
        raw({ fg: [235, 235, 235, 255], layers: [[21, 116, 140, 255]] }),
        raw({ fg: [235, 235, 235, 255], layers: [[244, 246, 248, 255]], images: [img(value)], colours: { [s]: [35, 114, 140, 255], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0] } }),
      ])
      expect(plain).toMatchObject({ ok: true })
      expect(plain!.note).toBeUndefined()
      expect(plain!.ratio).toBeCloseTo(4.507, 3)
      expect(several).toMatchObject({ ok: true, note: '2 gradients, bound over all stops' })
      expect(several!.ratio).toBeCloseTo(4.503, 3)
    })

    it('opaque text over a translucent layer: the layer gets its level, the text none', () => {
      const [row] = contrastRows([raw({ fg: [201, 201, 201, 255], layers: [[116, 116, 116, 90], [10, 70, 120, 255]] })])
      expect(row).toMatchObject({ ok: true })
      expect(row!.note).toBeUndefined()
      expect(row!.ratio).toBeCloseTo(4.652, 3)
    })

    it('opaque text on opaque colours is exact: 4.54:1 stays ok, and a clear pass with translucent layers too', () => {
      const rows = contrastRows([
        raw({ fg: [118, 118, 118, 255], layers: [[255, 255, 255, 255]] }),
        raw({ fg: [255, 255, 255, 185], layers: [[0, 0, 0, 128], [0, 90, 160, 255]] }),
      ])
      expect(rows[0]).toMatchObject({ ok: true })
      expect(rows[0]!.ratio).toBeCloseTo(4.542, 3)
      expect(rows[0]!.note).toBeUndefined()
      expect(rows[1]!.ratio).toBeGreaterThan(6)
      expect(rows[1]).toMatchObject({ ok: true })
      expect(rows[1]!.note).toBeUndefined()
    })
  })

  it('a background image or no opaque ancestor is indeterminate, not guessed silently', () => {
    expect(contrastRows([raw({ images: [img('linear-gradient(red, blue)')] })])[0]!.indeterminate).toMatch(/image/)
    const [row] = contrastRows([raw({ fg: [0, 0, 0, 255], layers: [[0, 0, 0, 0]] })])
    expect(row!.indeterminate).toMatch(/opaque/)
    expect(row!.bg).toEqual({ r: 255, g: 255, b: 255 })
  })

  it("DaisyUI's button noise texture is decoration, not a background image", () => {
    const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Cfilter id='a'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.34' numOctaves='4' stitchTiles='stitch'%3E%3C/feTurbulence%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23a)' opacity='0.2'%3E%3C/rect%3E%3C/svg%3E")`
    expect(coversBackground(`none, ${noise}`)).toBe(false)
    expect(coversBackground('none, none')).toBe(false)
    expect(coversBackground(`url("/bg.jpg"), ${noise}`)).toBe(true)
    expect(contrastRows([raw({ images: [img(`none, ${noise}`)] })])[0]!.indeterminate).toBeUndefined()
  })

  it('ok is ratio ≥ 4.5 and determinate: indeterminate is never a pass', () => {
    const rows = contrastRows([
      raw({}),
      raw({ fg: [119, 119, 119, 255], layers: [[255, 255, 255, 255]] }),
      raw({ images: [img('url("/bg.jpg")')] }),
      raw({ layers: [] }),
    ])
    expect(rows.map((r) => r.ok)).toEqual([true, false, false, false])
    expect(rows[2]!.ratio).toBeGreaterThan(4.5)
  })

  it('placeholder rows (#46: the embed placeholder on the dark theme of a client site) get the same maths', () => {
    // Light text from a dark theme's --color-base-content on daisyUI's light bg-base-200.
    const [row] = contrastRows([raw({ kind: 'placeholder', label: 'Exempel AB hämtas från Google Maps', fg: [218, 234, 245, 255], layers: [[248, 248, 248, 255]] })])
    expect(row).toMatchObject({ kind: 'placeholder', ok: false })
    expect(row!.ratio).toBeLessThan(1.5)
  })

  describe('gradients of solid colours (a client footer is a linear-gradient, the text white/70)', () => {
    const PRIMARY = 'rgb(0, 75, 133)'
    const DARK = 'rgb(0, 55, 95)'
    const FOOTER = `linear-gradient(180deg, ${PRIMARY} 0%, ${DARK} 100%)`
    const colours: RawContrast['colours'] = {
      [PRIMARY]: [0, 75, 133, 255],
      [DARK]: [0, 55, 95, 255],
      'rgb(250, 250, 250)': [250, 250, 250, 255],
      'rgba(0, 0, 0, 0.5)': [0, 0, 0, 128],
      'rgb(0, 0, 0)': [0, 0, 0, 255],
      'rgb(255, 0, 0)': [255, 0, 0, 255],
      'rgb(0, 255, 0)': [0, 255, 0, 255],
      'oklch(0.4 0.1 250)': [0, 75, 133, 255],
      'oklch(0.3 0.1 250)': [0, 55, 95, 255],
    }
    const WHITE70: RawContrast['fg'] = [255, 255, 255, 179]
    // The footer's own background-color is transparent; the body's white is the first opaque layer.
    const footer = (value: string, more: Partial<RawContrast> = {}) => raw({ fg: WHITE70, layers: [[255, 255, 255, 255]], images: [img(value)], colours, ...more })
    const vs = (fg: [number, number, number], bg: [number, number, number]) => {
      const a = 179 / 255
      const mixed = fg.map((c, i) => a * c + (1 - a) * bg[i]!)
      return wcagContrast({ r: mixed[0]!, g: mixed[1]!, b: mixed[2]! }, { r: bg[0], g: bg[1], b: bg[2] })
    }

    it('parses the computed value: prelude, stops with positions, hints, interpolation space', () => {
      expect(gradientStops(FOOTER)).toEqual({ stops: [PRIMARY, DARK] })
      expect(gradientStops('radial-gradient(circle at 50% 50%, rgba(0, 0, 0, 0.5), 30%, rgb(0, 0, 0) 40% 60%)')).toEqual({ stops: ['rgba(0, 0, 0, 0.5)', 'rgb(0, 0, 0)'] })
      expect(gradientStops('repeating-linear-gradient(to right, rgb(0, 0, 0) 0px, rgb(255, 0, 0) 10px)')).toEqual({ stops: ['rgb(0, 0, 0)', 'rgb(255, 0, 0)'] })
      expect(gradientStops('linear-gradient(in oklch 90deg, oklch(0.4 0.1 250), oklch(0.3 0.1 250))')).toEqual({ stops: ['oklch(0.4 0.1 250)', 'oklch(0.3 0.1 250)'], method: 'oklch' })
      expect(gradientStops('linear-gradient(to right in hsl longer hue, rgb(0, 0, 139), rgb(139, 0, 0))')).toEqual({ stops: ['rgb(0, 0, 139)', 'rgb(139, 0, 0)'], method: 'hsl longer hue' })
      expect(gradientStops('conic-gradient(from 90deg at 10px 20%, rgb(0, 0, 0), rgb(1, 1, 1))')).toEqual({ stops: ['rgb(0, 0, 0)', 'rgb(1, 1, 1)'] })
      expect(gradientStops('radial-gradient(farthest-corner ellipse at left top in srgb, rgb(0, 0, 0), rgb(1, 1, 1))')).toEqual({ stops: ['rgb(0, 0, 0)', 'rgb(1, 1, 1)'] })
      // Non-legacy stops interpolate in oklab by default (CSS Color 4).
      expect(gradientStops('linear-gradient(oklch(0.4 0.1 250), oklch(0.3 0.1 250))')).toEqual({ stops: ['oklch(0.4 0.1 250)', 'oklch(0.3 0.1 250)'], method: 'oklab' })
      for (const bad of [
        'url("/bg.jpg")',
        'linear-gradient(currentcolor, rgb(0, 0, 0))',
        'linear-gradient(rgb(0, 0, 0))',
        'linear-gradient(var(--x), rgb(0, 0, 0))',
        'image-set("a.png" 1x)',
        'linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0) foo)',
        // The prelude is whitelisted: an unknown keyword, space or hue method is not guessed at.
        'linear-gradient(sideways, rgb(0, 0, 0), rgb(1, 1, 1))',
        'linear-gradient(in foo, rgb(0, 0, 0), rgb(1, 1, 1))',
        'linear-gradient(in srgb longer hue, rgb(0, 0, 0), rgb(1, 1, 1))',
        'linear-gradient(in hsl longer, rgb(0, 0, 0), rgb(1, 1, 1))',
      ])
        expect(gradientStops(bad), bad).toBeUndefined()
    })

    it('a 2-stop gradient that is readable everywhere passes, measured against its worst stop', () => {
      const [row] = contrastRows([footer(FOOTER)])
      expect(row!.indeterminate).toBeUndefined()
      expect(row!.ok).toBe(true)
      expect(row!.note).toBe('gradient, worst stop')
      expect(row!.ratio).toBeCloseTo(Math.min(vs([255, 255, 255], [0, 75, 133]), vs([255, 255, 255], [0, 55, 95])), 5)
      expect(row!.bg).toEqual({ r: 0, g: 75, b: 133 })
      expect(formatContrast({ path: '/', ...row! })).toBe(`/ links "Cookie-inställningar" ${row!.ratio.toFixed(2)}:1 ok (gradient, worst stop)`)
    })

    it('one stop too light fails the row: the minimum wins', () => {
      const [row] = contrastRows([footer(`linear-gradient(${DARK}, rgb(250, 250, 250))`)])
      expect(row).toMatchObject({ ok: false, bg: { r: 250, g: 250, b: 250 } })
      expect(row!.indeterminate).toBeUndefined()
      expect(row!.ratio).toBeLessThan(1.5)
    })

    it('a url() image with the gradient stays indeterminate', () => {
      // A photo on top of the gradient, and a client site's hero: a translucent gradient over a photo.
      for (const value of [`url("/bg.jpg"), ${FOOTER}`, 'linear-gradient(rgba(0, 0, 0, 0.5), rgb(0, 0, 0) 100%), url("/hero.jpg")']) {
        const [row] = contrastRows([footer(value)])
        expect(row, value).toMatchObject({ ok: false, indeterminate: 'background image behind the text' })
      }
      // An opaque gradient painted over a photo hides it.
      expect(contrastRows([footer(`${FOOTER}, url("/bg.jpg")`)])[0]).toMatchObject({ ok: true, note: 'gradient, worst stop' })
    })

    it('stops with alpha are composited over the background beneath', () => {
      // Black text; a gradient from half-black to black over a red footer colour.
      const [row] = contrastRows([raw({ fg: [255, 255, 255, 255], layers: [[255, 0, 0, 255]], images: [img('linear-gradient(rgba(0, 0, 0, 0.5), rgb(0, 0, 0))')], colours })])
      expect(row!.indeterminate).toBeUndefined()
      expect(row!.bg).toEqual({ r: 127, g: 0, b: 0 })
      expect(row!.ratio).toBeCloseTo(wcagContrast({ r: 255, g: 255, b: 255 }, { r: 127, g: 0, b: 0 }), 5)
    })

    it('the worst point can lie between stops (red to green dips below both in luminance)', () => {
      const [row] = contrastRows([raw({ fg: [0, 0, 0, 255], layers: [[255, 255, 255, 255]], images: [img('linear-gradient(rgb(255, 0, 0), rgb(0, 255, 0))')], colours })])
      expect(row!.note).toBe('gradient, worst point between stops')
      expect(row!.ratio).toBeLessThan(wcagContrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 0, b: 0 }))
    })

    it('another interpolation space is not guessed: without the page mixing its points it is indeterminate', () => {
      const [row] = contrastRows([footer('linear-gradient(in oklch, oklch(0.4 0.1 250), oklch(0.3 0.1 250))')])
      expect(row).toMatchObject({ ok: false, indeterminate: 'gradient colour the page did not resolve' })
      expect(pendingColours([footer('linear-gradient(in oklch, oklch(0.4 0.1 250), oklch(0.3 0.1 250))')])).toContain('color-mix(in oklch, oklch(0.4 0.1 250) 50%, oklch(0.3 0.1 250) 50%)')
    })

    it('a stop the page could not rasterise is indeterminate', () => {
      const [row] = contrastRows([footer('linear-gradient(rgb(1, 2, 3), rgb(0, 0, 0))')])
      expect(row).toMatchObject({ ok: false, indeterminate: 'gradient colour the page did not resolve' })
    })

    it('an opaque gradient hides what is beneath it: no opaque colour needed, a body photo ignored', () => {
      const [row] = contrastRows([raw({ fg: WHITE70, layers: [[255, 255, 255, 255]], images: [img(FOOTER, 0), img('url("/body.jpg")', 0)], colours })])
      expect(row).toMatchObject({ ok: true, note: 'gradient, worst stop' })
      const [none] = contrastRows([raw({ fg: WHITE70, layers: [], images: [img(FOOTER, 0)], colours })])
      expect(none).toMatchObject({ ok: true, note: 'gradient, worst stop' })
    })

    it('a gradient that may not cover the box also counts the colour beneath', () => {
      const [row] = contrastRows([footer(FOOTER, { images: [img(FOOTER, 0, { size: '50% 50%', repeat: 'no-repeat' })] })])
      expect(row).toMatchObject({ ok: false, bg: { r: 255, g: 255, b: 255 } })
    })

    it('measureContrast rasterises the stops in the page (var() already resolved by computed style)', async () => {
      const calls: string[] = []
      const page = {
        evaluate: async (src: string) => {
          calls.push(src)
          if (calls.length === 1) return [raw({ fg: WHITE70, layers: [[255, 255, 255, 255]], images: [img(FOOTER)] })]
          expect(src).toContain(JSON.stringify([PRIMARY, DARK]))
          return [[0, 75, 133, 255], [0, 55, 95, 255]]
        },
      }
      const [row] = await measureContrast(page as never)
      expect(calls).toHaveLength(2)
      expect(row).toMatchObject({ ok: true, note: 'gradient, worst stop' })
    })

    // A stand-in for the page's colour resolution: rgb() as is, and color-mix in hsl longer hue.
    const resolve = (css: string): RawContrast['fg'] | null => {
      const rgb = (s: string) => s.match(/\d+/g)!.map(Number) as [number, number, number]
      if (/^rgb\(/.test(css)) return [...rgb(css), 255]
      if (/^rgba\(/.test(css)) {
        const [r, g, b, a] = css.match(/[\d.]+/g)!.map(Number) as [number, number, number, number]
        return [r, g, b, Math.round(a * 255)]
      }
      const m = /^color-mix\(in hsl longer hue, (rgb\([^)]*\)) ([\d.]+)%, (rgb\([^)]*\)) ([\d.]+)%\)$/.exec(css)
      if (!m) return null
      const toHsl = ([r, g, b]: number[]) => {
        const [R, G, B] = [r! / 255, g! / 255, b! / 255]
        const max = Math.max(R, G, B)
        const min = Math.min(R, G, B)
        const l = (max + min) / 2
        const d = max - min
        const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
        const h = d === 0 ? 0 : max === R ? 60 * (((G - B) / d + 6) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4)
        return [h, s, l] as const
      }
      const fromHsl = (h: number, s: number, l: number) => {
        const f = (n: number) => {
          const k = (n + h / 30) % 12
          return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
        }
        return [f(0), f(8), f(4)].map((v) => Math.round(v * 255))
      }
      const a = toHsl(rgb(m[1]!))
      const b = toHsl(rgb(m[3]!))
      const t = Number(m[4]) / 100
      let [h1, h2] = [a[0], b[0]]
      const d = h2 - h1
      if (d > 0 && d < 180) h1 += 360
      else if (d > -180 && d <= 0) h2 += 360
      const h = (((h1 + (h2 - h1) * t) % 360) + 360) % 360
      return [...(fromHsl(h, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t) as [number, number, number]), 255]
    }
    const fakePage = (rows: RawContrast[]) => {
      const calls: string[] = []
      return {
        calls,
        evaluate: async (src: string) => {
          calls.push(src)
          if (calls.length === 1) return rows
          return (JSON.parse(/\)\((\[.*\])\)$/s.exec(src)![1]!) as string[]).map(resolve)
        },
      }
    }

    it('#1 another space is mixed by the page: white on darkblue to darkred in hsl longer hue passes yellow, 3.64:1', async () => {
      const value = 'linear-gradient(to right in hsl longer hue, rgb(0, 0, 139), rgb(139, 0, 0))'
      const page = fakePage([raw({ fg: [255, 255, 255, 255], layers: [[255, 255, 255, 255]], images: [img(value)] })])
      const [row] = await measureContrast(page as never)
      expect(row!.indeterminate).toBeUndefined()
      expect(row).toMatchObject({ ok: false, note: 'gradient, worst point between stops; interpolated in hsl longer hue' })
      expect(row!.ratio).toBeCloseTo(3.64, 1)
      expect(page.calls.some((c) => c.includes('color-mix(in hsl longer hue, rgb(0, 0, 139)'))).toBe(true)
    })

    it('a mix the page does not resolve stays indeterminate', async () => {
      const page = fakePage([raw({ fg: [255, 255, 255, 255], layers: [[255, 255, 255, 255]], images: [img('linear-gradient(in lch, rgb(0, 0, 139), rgb(139, 0, 0))')] })])
      const [row] = await measureContrast(page as never)
      expect(row).toMatchObject({ ok: false, indeterminate: 'gradient colour the page did not resolve' })
    })

    it('#5 the worst point is found to well within 0.001, not just the nearest sample', () => {
      let seed = 42
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
      const c = () => Math.floor(rnd() * 256)
      const lerp = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i]! - x) * t)
      let worstGap = 0
      for (let n = 0; n < 200; n++) {
        const a = [c(), c(), c()]
        const b = [c(), c(), c()]
        const fg: RawContrast['fg'] = [c(), c(), c(), 128 + Math.floor(rnd() * 128)]
        const colours = { [`rgb(${a.join(', ')})`]: [...a, 255], [`rgb(${b.join(', ')})`]: [...b, 255] } as RawContrast['colours']
        const [row] = contrastRows([raw({ fg, layers: [[255, 255, 255, 255]], images: [img(`linear-gradient(rgb(${a.join(', ')}), rgb(${b.join(', ')}))`)], colours })])
        let brute = Infinity
        for (let k = 0; k <= 10000; k++) {
          const [r, g, bb] = lerp(a, b, k / 10000) as [number, number, number]
          const al = fg[3] / 255
          const f = { r: al * fg[0] + (1 - al) * r, g: al * fg[1] + (1 - al) * g, b: al * fg[2] + (1 - al) * bb }
          brute = Math.min(brute, wcagContrast(f, { r, g, b: bb }))
        }
        worstGap = Math.max(worstGap, row!.ratio - brute)
      }
      expect(worstGap).toBeLessThan(1e-4)
    }, 30_000)

    it('an opaque gradient on top hides the other one: measured as one gradient', () => {
      const top = 'linear-gradient(rgba(0, 0, 0, 0.5), rgb(0, 0, 0))'
      expect(contrastRows([footer(`${FOOTER}, ${top}`)])[0]).toMatchObject({ ok: true, note: 'gradient, worst stop' })
    })

    describe('several gradients that show (#90 item 5): a per-channel bound over every colour each layer can show', () => {
      const more: RawContrast['colours'] = {
        ...colours,
        'rgba(127, 183, 226, 0.18)': [127, 183, 226, 46],
        'rgba(0, 0, 0, 0)': [0, 0, 0, 0],
        'rgb(21, 36, 47)': [21, 36, 47, 255],
        'rgb(13, 25, 34)': [13, 25, 34, 255],
        'rgba(255, 255, 255, 0.5)': [255, 255, 255, 128],
        'rgba(255, 255, 255, 0)': [255, 255, 255, 0],
        'rgba(0, 0, 0, 0.25)': [0, 0, 0, 64],
        'rgb(250, 250, 250)': [250, 250, 250, 255],
        'rgb(200, 200, 200)': [200, 200, 200, 255],
        'rgb(255, 255, 255)': [255, 255, 255, 255],
        'rgb(30, 30, 30)': [30, 30, 30, 255],
      }
      const two = (fg: RawContrast['fg'], value: string) => raw({ fg, layers: [[244, 246, 248, 255]], images: [img(value)], colours: more })
      const mix = (top: RawContrast['fg'], below: [number, number, number]) => {
        const a = top[3] / 255
        return { r: a * top[0] + (1 - a) * below[0], g: a * top[1] + (1 - a) * below[1], b: a * top[2] + (1 - a) * below[2] }
      }
      /** A composite moved outward by the bound's 8-bit margin: rounded away and one level further. */
      const lighter = (c: Rgb): Rgb => ({ r: Math.min(255, Math.ceil(c.r) + 1), g: Math.min(255, Math.ceil(c.g) + 1), b: Math.min(255, Math.ceil(c.b) + 1) })
      const darker = (c: Rgb): Rgb => ({ r: Math.max(0, Math.floor(c.r) - 1), g: Math.max(0, Math.floor(c.g) - 1), b: Math.max(0, Math.floor(c.b) - 1) })

      it('a client footer: #dbe6ef over a faint radial glow on a dark linear gradient passes; lightest point 8.70:1, bound 8.50:1', () => {
        const value = 'radial-gradient(at 80% 0%, rgba(127, 183, 226, 0.18), rgba(0, 0, 0, 0) 55%), linear-gradient(158deg, rgb(21, 36, 47), rgb(13, 25, 34))'
        const [row] = contrastRows([two([219, 230, 239, 255], value)])
        expect(row!.indeterminate).toBeUndefined()
        // The glow at full strength (alpha 0.18, read back as 46/255) over the lighter end of the linear
        // gradient: 8.70:1. The opaque sRGB gradient is exact; the glow's fold gets the 8-bit margin.
        const lightest = mix([127, 183, 226, 46], [21, 36, 47])
        expect(wcagContrast({ r: 219, g: 230, b: 239 }, lightest)).toBeCloseTo(8.7, 2)
        expect(row).toMatchObject({ ok: true, note: '2 gradients, bound over all stops', bg: { r: 42, g: 64, b: 81 } })
        expect(row!.ratio).toBeCloseTo(wcagContrast({ r: 219, g: 230, b: 239 }, lighter(lightest)), 5)
        expect(row!.ratio).toBeCloseTo(8.5, 2)
      })

      it('translucent text over several gradients (#96): ok allows for the text\'s own rounding too', () => {
        const value = 'radial-gradient(at 80% 0%, rgba(127, 183, 226, 0.18), rgba(0, 0, 0, 0) 55%), linear-gradient(158deg, rgb(21, 36, 47), rgb(13, 25, 34))'
        const [near, clear] = contrastRows([two([255, 255, 255, 142], value), two([255, 255, 255, 144], value)])
        expect(near).toMatchObject({ ok: false, note: '2 gradients, bound over all stops; within the 8-bit margin of 4.5' })
        expect(near!.ratio).toBeCloseTo(4.519, 3)
        expect(clear).toMatchObject({ ok: true, note: '2 gradients, bound over all stops' })
        expect(clear!.ratio).toBeCloseTo(4.601, 3)
      })

      it('light text: a translucent white layer over a blue one fails at the lightest composite', () => {
        const value = `linear-gradient(rgba(255, 255, 255, 0.5), rgba(0, 0, 0, 0)), ${FOOTER}`
        const [row] = contrastRows([two([255, 255, 255, 255], value)])
        expect(row!.indeterminate).toBeUndefined()
        expect(row!.ok).toBe(false)
        expect(row!.ratio).toBeCloseTo(wcagContrast({ r: 255, g: 255, b: 255 }, lighter(mix([255, 255, 255, 128], [0, 75, 133]))), 5)
      })

      it('dark text: the bound flips to the darkest composite', () => {
        const value = 'linear-gradient(rgba(0, 0, 0, 0.25), rgba(0, 0, 0, 0)), linear-gradient(rgb(250, 250, 250), rgb(200, 200, 200))'
        const [row] = contrastRows([two([0, 0, 0, 255], value)])
        expect(row!.indeterminate).toBeUndefined()
        const darkest = darker(mix([0, 0, 0, 64], [200, 200, 200]))
        expect(row).toMatchObject({ ok: true, bg: darkest })
        expect(row!.ratio).toBeCloseTo(wcagContrast({ r: 0, g: 0, b: 0 }, darkest), 5)
      })

      it('a transparent stop in the top layer exposes the layer below', () => {
        // White on top would make black text readable; where it fades out, the black below shows.
        const value = 'linear-gradient(rgb(255, 255, 255), rgba(255, 255, 255, 0)), linear-gradient(rgb(0, 0, 0), rgb(30, 30, 30))'
        const [row] = contrastRows([two([0, 0, 0, 255], value)])
        expect(row!.indeterminate).toBeUndefined()
        expect(row).toMatchObject({ ok: false, bg: { r: 0, g: 0, b: 0 } })
        expect(row!.ratio).toBeCloseTo(1, 5)
      })

      it('text whose luminance lies inside the range the layers span is bounded at 1:1', () => {
        const value = 'linear-gradient(rgb(255, 255, 255), rgba(255, 255, 255, 0)), linear-gradient(rgb(0, 0, 0), rgb(30, 30, 30))'
        const [row] = contrastRows([two([128, 128, 128, 255], value)])
        expect(row).toMatchObject({ ok: false, ratio: 1 })
        expect(row!.indeterminate).toBeUndefined()
      })

      it('translucent text is bounded too, never above its true worst point', () => {
        // White/70 over half-white on blue: the worst true point is the lightest composite.
        const value = `linear-gradient(rgba(255, 255, 255, 0.5), rgba(0, 0, 0, 0)), ${FOOTER}`
        const [row] = contrastRows([two(WHITE70, value)])
        const bg = mix([255, 255, 255, 128], [0, 75, 133])
        const exact = wcagContrast(mix(WHITE70, [bg.r, bg.g, bg.b]), bg)
        expect(row!.ratio).toBeLessThanOrEqual(exact + 1e-9)
        expect(row!.ratio).toBeGreaterThan(exact * 0.9)
        expect(row!.ok).toBe(false)
      })

      it('a layer in another space: the page mixes its points, the bound covers them (never above the one-gradient worst)', async () => {
        const hsl = 'linear-gradient(to right in hsl longer hue, rgb(0, 0, 139), rgb(139, 0, 0))'
        const [alone] = await measureContrast(fakePage([raw({ fg: [255, 255, 255, 255], layers: [[255, 255, 255, 255]], images: [img(hsl)] })]) as never)
        const page = fakePage([raw({ fg: [255, 255, 255, 255], layers: [[255, 255, 255, 255]], images: [img(`linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0)), ${hsl}`)] })])
        const [row] = await measureContrast(page as never)
        expect(row!.indeterminate).toBeUndefined()
        expect(row).toMatchObject({ ok: false, note: '2 gradients, bound over all stops; points between stops sampled in hsl longer hue' })
        expect(row!.ratio).toBeLessThanOrEqual(alone!.ratio + 1e-9)
        expect(page.calls.some((c) => c.includes('color-mix(in hsl longer hue, rgb(0, 0, 139)'))).toBe(true)
      })

      it('a gradient colour the page did not resolve stays indeterminate', () => {
        const [row] = contrastRows([two([255, 255, 255, 255], `linear-gradient(rgb(1, 2, 3), rgba(0, 0, 0, 0)), ${FOOTER}`)])
        expect(row).toMatchObject({ ok: false, indeterminate: 'gradient colour the page did not resolve' })
        expect(pendingColours([two([255, 255, 255, 255], `linear-gradient(rgba(9, 9, 9, 0.5), rgba(0, 0, 0, 0)), ${FOOTER}`)])).toEqual(['rgba(9, 9, 9, 0.5)'])
      })

      describe('brute force (#92 review): the bound is never above the worst point the stack can show', () => {
        type C = RawContrast['fg']
        const toLin = (c: number) => {
          const v = c / 255
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
        }
        const fromLin = (v: number) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
        /** color-mix(in srgb-linear, a, b t): premultiplied in linear light, exact (no 8-bit rounding). */
        const mixLinear = (a: C, b: C, t: number): C => {
          const alpha = a[3] * (1 - t) + b[3] * t
          if (alpha === 0) return [0, 0, 0, 0]
          const ch = (j: number) => fromLin((toLin(a[j]!) * a[3] * (1 - t) + toLin(b[j]!) * b[3] * t) / alpha)
          return [ch(0), ch(1), ch(2), alpha]
        }
        /** Premultiplied sRGB, as a gradient without an `in` method is painted. */
        const mixSrgb = (a: C, b: C, t: number): C => {
          const alpha = a[3] * (1 - t) + b[3] * t
          if (alpha === 0) return [0, 0, 0, 0]
          const ch = (j: number) => (a[j]! * a[3] * (1 - t) + b[j]! * b[3] * t) / alpha
          return [ch(0), ch(1), ch(2), alpha]
        }
        const parse = (css: string): C | undefined => {
          const m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(css)
          return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 255 : Number(m[4]) * 255] : undefined
        }
        const MIX = /^color-mix\(in srgb-linear, (rgba?\([^)]*\)) [\d.]+%, (rgba?\([^)]*\)) ([\d.]+)%\)$/
        /** The page: stops as written, srgb-linear mixes computed exactly; every mix null when `refuse`. */
        const linearPage = (rows: RawContrast[], refuse = false) => {
          let first = true
          return {
            evaluate: async (src: string) => {
              if (first) return ((first = false), rows)
              return (JSON.parse(/\)\((\[.*\])\)$/s.exec(src)![1]!) as string[]).map((css) => {
                const m = MIX.exec(css)
                if (!m) return parse(css) ?? null
                return refuse ? null : mixLinear(parse(m[1]!)!, parse(m[2]!)!, Number(m[3]) / 100)
              })
            },
          }
        }
        const overC = (top: C, below: Rgb): Rgb => {
          const a = top[3] / 255
          return { r: a * top[0] + (1 - a) * below.r, g: a * top[1] + (1 - a) * below.g, b: a * top[2] + (1 - a) * below.b }
        }

        type Grad = { stops: [string, C][]; linear: boolean; covers: boolean }
        const value = (gs: Grad[]) =>
          [...gs]
            .reverse()
            .map((g) => `linear-gradient(${g.linear ? 'in srgb-linear, ' : ''}${g.stops.map(([s]) => s).join(', ')})`)
            .join(', ')
        const image = (gs: Grad[], at: number): BgImage => {
          const top = [...gs].reverse()
          return {
            value: value(gs),
            at,
            size: top.map((g) => (g.covers ? 'auto' : '50% 50%')).join(', '),
            repeat: top.map((g) => (g.covers ? 'repeat' : 'no-repeat')).join(', '),
            position: top.map(() => '0% 0%').join(', '),
          }
        }
        /** Every colour a layer can show, sampled finely; undefined where it may leave the box uncovered. */
        const SAMPLES = 8
        const points = (g: Grad): (C | undefined)[] => {
          const out: (C | undefined)[] = g.covers ? [] : [undefined]
          for (let i = 1; i < g.stops.length; i++)
            for (let k = 0; k <= SAMPLES; k++) out.push((g.linear ? mixLinear : mixSrgb)(g.stops[i - 1]![1], g.stops[i]![1], k / SAMPLES))
          return out
        }
        /** The true worst ratio over every combination of sampled points, bottom-up. */
        const truth = (fg: C, base: C, below: Grad[], mid: C | undefined, above: Grad[]) => {
          let bgs: Rgb[] = [{ r: base[0], g: base[1], b: base[2] }]
          const fold = (pts: (C | undefined)[]) => (bgs = bgs.flatMap((bg) => pts.map((p) => (p ? overC(p, bg) : bg))))
          for (const g of below) fold(points(g))
          if (mid) fold([mid])
          for (const g of above) fold(points(g))
          return Math.min(...bgs.map((bg) => wcagContrast(overC(fg, bg), bg)))
        }

        let seed = 92
        const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
        const byte = () => Math.floor(rnd() * 256)
        const rgb = (): [number, number, number] => {
          const x = rnd()
          return x < 0.15 ? [0, 0, 0] : x < 0.3 ? [255, 255, 255] : [byte(), byte(), byte()]
        }
        /** An opaque, transparent or translucent stop, as the computed value writes it and the page reads it. */
        const stop = (): [string, C] => {
          const [r, g, b] = rgb()
          const x = rnd()
          if (x < 0.3) return [`rgb(${r}, ${g}, ${b})`, [r, g, b, 255]]
          const a = x < 0.5 ? 0 : Math.round(5 + rnd() * 90) / 100
          return [`rgba(${r}, ${g}, ${b}, ${a})`, [r, g, b, a * 255]]
        }
        const grad = (linear: boolean): Grad => ({ stops: Array.from({ length: rnd() < 0.7 ? 2 : 3 }, stop), linear, covers: rnd() < 0.65 })

        const CASES = 300
        // Once as verify runs, and once with the 8-bit margin off: the margin is slack, and without it the
        // fold maths alone must still never land above the truth (the reference does not round).
        for (const margin of [1, 0])
        it(`${CASES} random stacks of 2–3 gradients (sRGB and srgb-linear), a colour layer between, opaque and translucent text; margin ${margin}`, async () => {
          seed = 92
          let worstGap = -Infinity
          let close = 0
          for (let n = 0; n < CASES; n++) {
            const count = rnd() < 0.6 ? 2 : 3
            const linearAt = Math.floor(rnd() * count)
            const gs = Array.from({ length: count }, (_, i) => grad(i === linearAt || rnd() < 0.3))
            const base: C = [...rgb(), 255]
            // A translucent colour on an element between two of the gradients, or none.
            const split = rnd() < 0.4 ? 1 + Math.floor(rnd() * (count - 1)) : 0
            const mid: C | undefined = split ? [...rgb(), Math.round(25 + rnd() * 205)] : undefined
            const [below, above] = split ? [gs.slice(0, split), gs.slice(split)] : [gs, []]
            const fg: C = [...rgb(), rnd() < 0.6 ? 255 : 128 + Math.floor(rnd() * 127)]
            const row = raw(
              mid
                ? { fg, layers: [mid, base], images: [image(above, 0), image(below, 1)] }
                : { fg, layers: [base], images: [image(below, 0)] },
            )
            const [got] = await measureContrast(linearPage([row]) as never, { margin })
            const exact = truth(fg, base, below, mid, above)
            const at = `case ${n}: ${JSON.stringify({ fg, base, mid, value: value(gs), coversBottomUp: gs.map((g) => g.covers) })}`
            expect(got!.indeterminate, at).toBeUndefined()
            expect(got!.ratio, at).toBeLessThanOrEqual(exact + 1e-6)
            if (exact < 4.5) expect(got!.ok, at).toBe(false)
            worstGap = Math.max(worstGap, got!.ratio - exact)
            if (got!.ratio > exact * 0.8) close++
          }
          // Not vacuous: most bounds are close to the truth, not 1:1 everywhere.
          expect(close).toBeGreaterThan(CASES / 2)
          expect(worstGap).toBeLessThanOrEqual(1e-6)
        }, 60_000)
        it('an opaque, covering gradient in another method is widened too; an sRGB one is exact', async () => {
          // The page's mixes are read back in 8 bits like any colour, so only an sRGB gradient, whose
          // points the tool interpolates from its 8-bit stops, may skip the margin.
          const stack = (method: string) => `linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0)), linear-gradient(${method}rgb(0, 0, 0), rgb(0, 0, 0))`
          const bg = async (method: string) => {
            const rows = [two([255, 255, 255, 255], stack(method))]
            rows[0]!.colours = undefined
            const page = linearPage(rows)
            // As the canvas reads them: whole 8-bit values (the exact mixes carry float noise of their own).
            const rounded = {
              evaluate: async (src: string) => {
                const got = (await page.evaluate(src)) as unknown[]
                return Array.isArray(got[0]) ? (got as C[]).map((c) => c.map(Math.round)) : got
              },
            }
            const [got] = await measureContrast(rounded as never)
            expect(got!.indeterminate, method).toBeUndefined()
            return got!.bg
          }
          // Black, then the transparent layer's fold: one level for it, one more for the srgb-linear layer.
          expect(await bg('')).toEqual({ r: 1, g: 1, b: 1 })
          expect(await bg('in srgb-linear, ')).toEqual({ r: 2, g: 2, b: 2 })
        })
        it('a color-mix the page answers with null, in one of several layers, stays indeterminate', async () => {
          const rows = [two([255, 255, 255, 255], 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0)), linear-gradient(in srgb-linear, rgb(0, 0, 139), rgb(139, 0, 0))')]
          rows[0]!.colours = undefined
          const [got] = await measureContrast(linearPage(rows, true) as never)
          expect(got).toMatchObject({ ok: false, indeterminate: 'gradient colour the page did not resolve' })
          expect(got!.note).toBeUndefined()
        })
      })

      it('8-bit rounding (#92 review): the bound stays at or below the lightest pixel Chromium paints', () => {
        // The canvas reads rgba(255, 255, 255, 0.15) back as alpha 38/255 = 0.149, a little less than
        // the 0.15 the page paints with. Unrounded, the bound came out at 6.97:1, above the lightest
        // pixel headless Chromium paints for this background, rgb(67, 82, 96): 6.92:1 against #eee.
        const value = 'repeating-conic-gradient(rgba(0, 0, 0, 0.4) 0deg 10deg, rgba(255, 255, 255, 0.15) 10deg 20deg), radial-gradient(closest-side, rgb(34, 51, 68), rgb(17, 34, 51))'
        const colours: RawContrast['colours'] = {
          'rgba(0, 0, 0, 0.4)': [0, 0, 0, 102],
          'rgba(255, 255, 255, 0.15)': [255, 255, 255, 38],
          'rgb(34, 51, 68)': [34, 51, 68, 255],
          'rgb(17, 34, 51)': [17, 34, 51, 255],
        }
        const [row] = contrastRows([raw({ fg: [238, 238, 238, 255], layers: [[255, 255, 255, 255]], images: [img(value)], colours })])
        const painted = wcagContrast({ r: 238, g: 238, b: 238 }, { r: 67, g: 82, b: 96 })
        expect(painted).toBeCloseTo(6.92, 2)
        expect(row!.indeterminate).toBeUndefined()
        expect(row!.ratio).toBeLessThanOrEqual(painted)
        // A margin of a level or two per layer, not a different answer.
        expect(row!.ratio).toBeGreaterThan(painted - 0.4)
        expect(row!.ok).toBe(true)
      })

      it('a colour layer between two gradients is composited between them', () => {
        // Dark text; a translucent black on the inner element between a light gradient below and a
        // fading white one above. The darkest point: the black over rgb(200, 200, 200), the top faded out.
        const row = raw({
          fg: [0, 0, 0, 255],
          layers: [[0, 0, 0, 64], [244, 246, 248, 255]],
          images: [img('linear-gradient(rgba(255, 255, 255, 0.5), rgba(0, 0, 0, 0))', 0), img('linear-gradient(rgb(250, 250, 250), rgb(200, 200, 200))', 1)],
          colours: more,
        })
        const [got] = contrastRows([row])
        expect(got!.indeterminate).toBeUndefined()
        const darkest = mix([0, 0, 0, 64], [200, 200, 200])
        const exact = wcagContrast({ r: 0, g: 0, b: 0 }, darkest)
        expect(got!.ratio).toBeLessThanOrEqual(exact + 1e-9)
        expect(got!.ratio).toBeGreaterThan(wcagContrast({ r: 0, g: 0, b: 0 }, { r: darkest.r - 3, g: darkest.g - 3, b: darkest.b - 3 }))
        expect(got).toMatchObject({ ok: true, note: '2 gradients, bound over all stops' })
      })

    })
  })

  describe('effects the colours do not show (#2–#4): indeterminate', () => {
    it('background-blend-mode, background-clip: text, filter, mix-blend-mode, backdrop-filter, opacity over a background', () => {
      for (const effect of ['background-blend-mode', 'background-clip', 'opacity', 'mix-blend-mode', 'filter', 'backdrop-filter', 'positioned ::before with a background']) {
        const [row] = contrastRows([raw({ effects: [effect] })])
        expect(row, effect).toMatchObject({ ok: false, indeterminate: `effect on the text or its background: ${effect}` })
        expect(row!.ratio, effect).toBeCloseTo(21, 5)
      }
    })

    it('an opacity animation still running on the way is "animation not settled", never a fail or a pass', () => {
      const [row] = contrastRows([raw({ animating: true, fade: 0 })])
      expect(row).toMatchObject({ ok: false, indeterminate: 'animation not settled' })
    })

    it('measureContrast waits for a running animation on the way and measures once more (data-animate fade-in)', async () => {
      const calls: string[] = []
      const page = {
        evaluate: async (src: string) => {
          calls.push(src)
          if (src.includes('.finished')) return true
          // First read: mid-fade. Second read, after the wait: settled.
          return calls.length === 1 ? [raw({ animating: true, fade: 0.3 })] : [raw({})]
        },
      }
      const [row] = await measureContrast(page as never)
      expect(calls.filter((c) => c.includes('.finished'))).toHaveLength(1)
      expect(calls).toHaveLength(3)
      expect(row).toMatchObject({ ok: true })
      expect(row!.indeterminate).toBeUndefined()

      // Still animating after the wait: indeterminate, no further retries.
      const stuck = { evaluate: async (src: string) => (src.includes('.finished') ? false : [raw({ animating: true })]) }
      expect((await measureContrast(stuck as never))[0]).toMatchObject({ ok: false, indeterminate: 'animation not settled' })
    })

    it('opacity on the text with no background of its own fades the text colour (a footer opacity-70)', () => {
      const [row] = contrastRows([raw({ fg: [255, 255, 255, 255], fade: 0.7, layers: [[0, 0, 0, 255]] })])
      expect(row!.indeterminate).toBeUndefined()
      expect(row!.ratio).toBeCloseTo(wcagContrast({ r: 178.5, g: 178.5, b: 178.5 }, { r: 0, g: 0, b: 0 }), 5)
      expect(row!.fg).toEqual({ r: 179, g: 179, b: 179 })
    })
  })

  it('labels each row with its kind and text', () => {
    const [row] = contrastRows([raw({ kind: 'banner', label: 'Neka' })])
    expect(row).toMatchObject({ kind: 'banner', button: 'Neka' })
    expect(row!.ratio).toBeCloseTo(21, 5)
  })
})

describe('embed heights (#46: a client site, an in-flow wrapper in a padding-ratio box)', () => {
  const box = (path: string, width: number, h: number, service: EmbedBox['service'] = 'google-maps'): EmbedBox => ({ path, width, service, h })

  it('pairs main iframes with branch placeholders in page order per path and width', () => {
    const r = compareEmbedHeights([box('/kontakt', 1280, 460), box('/kontakt', 360, 320)], [box('/kontakt', 1280, 460), box('/kontakt', 360, 320)])
    expect(r.rows.map((x) => [x.path, x.width, x.index, x.mainH, x.branchH, x.ok])).toEqual([
      ['/kontakt', 1280, 1, 460, 460, true],
      ['/kontakt', 360, 1, 320, 320, true],
    ])
    expect(r.notes).toEqual([])
  })

  it('a placeholder more than 10 % shorter than the iframe it replaced fails; taller or within 10 % passes', () => {
    const r = compareEmbedHeights(
      [box('/kontakt', 1280, 460), box('/a', 1280, 400), box('/b', 1280, 400)],
      [box('/kontakt', 1280, 320), box('/a', 1280, 361), box('/b', 1280, 600)],
    )
    expect(r.rows.map((x) => x.ok)).toEqual([false, true, true])
  })

  it('different counts on a page are not compared, and say so (a map main built in a script, on a client site)', () => {
    const r = compareEmbedHeights([], [box('/kontakt', 1280, 420)])
    expect(r.rows).toEqual([])
    expect(r.notes).toEqual(['/kontakt 1280px google-maps: 0 registry iframes on main, 1 embed on the branch: heights not compared'])
  })

  it('pairs per service, so a calendar main kept as an iframe is never compared with a map placeholder', () => {
    // Main: a calendar iframe the branch did not convert, then the map. Branch: a map main built in
    // a script, then the map. Page order alone would pair the calendar (200px) with the first map.
    const r = compareEmbedHeights(
      [box('/', 1280, 200, 'google-calendar'), box('/', 1280, 450)],
      [box('/', 1280, 450), box('/', 1280, 450)],
    )
    expect(r.rows).toEqual([])
    expect(r.notes).toEqual([
      '/ 1280px google-maps: 1 registry iframe on main, 2 embeds on the branch: heights not compared',
    ])
    const same = compareEmbedHeights([box('/', 1280, 200, 'google-calendar'), box('/', 1280, 450)], [box('/', 1280, 200, 'google-calendar'), box('/', 1280, 320)])
    expect(same.rows.map((x) => [x.service, x.ok])).toEqual([['google-calendar', true], ['google-maps', false]])
  })
})

describe('root styles (a client site: daisyUI added where main had none)', () => {
  const main = { 'html scrollbar-color': 'auto', 'html background-color': 'rgb(247, 247, 245)' }

  it('the same on main and the branch: no lines', () => {
    expect(diffRootStyles(main, { ...main })).toEqual([])
  })

  it('a difference names the element, the property and both values', () => {
    const branch = { ...main, 'html scrollbar-color': 'color-mix(in oklch, currentcolor 35%, rgba(0, 0, 0, 0)) rgba(0, 0, 0, 0)' }
    expect(diffRootStyles(main, branch)).toEqual([
      'html scrollbar-color: main auto, branch color-mix(in oklch, currentcolor 35%, rgba(0, 0, 0, 0)) rgba(0, 0, 0, 0)',
    ])
  })
})

describe('consent paths: Visa alltid pairing', () => {
  it('tries every other page from the next one, then a reload of the page itself', () => {
    expect(rememberCandidates(['/a', '/b', '/c'], 0)).toEqual(['/b', '/c', '/a'])
    expect(rememberCandidates(['/a', '/b', '/c'], 1)).toEqual(['/c', '/a', '/b'])
    expect(rememberCandidates(['/a', '/b', '/c'], 2)).toEqual(['/a', '/b', '/c'])
    expect(rememberCandidates(['/a'], 0)).toEqual(['/a'])
  })

  const counts = (c: Partial<RememberCounts> = {}): RememberCounts => ({ clicked: true, same: 2, sameActive: 2, other: 1, otherActive: 0, banner: false, ...c })
  it('passes when every embed of the remembered service loads and nothing else does', () => {
    expect(rememberOk(counts())).toBe(true)
    expect(rememberOk(counts({ other: 0 }))).toBe(true)
  })
  it('fails when another service loads too (remembering S grants S only)', () => {
    expect(rememberOk(counts({ otherActive: 1 }))).toBe(false)
  })
  it('fails when an embed of the remembered service stays a placeholder, none exists, the click did nothing or a banner opens', () => {
    expect(rememberOk(counts({ sameActive: 1 }))).toBe(false)
    expect(rememberOk(counts({ same: 0, sameActive: 0 }))).toBe(false)
    expect(rememberOk(counts({ clicked: false }))).toBe(false)
    expect(rememberOk(counts({ banner: true }))).toBe(false)
  })
})
