import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contrastRows, coversBackground, measureContrast, type RawContrast } from '../../../ci/rollout/checks/contrast'
import { extractLinks, listPages, MISSING_PREFIX } from '../../../ci/rollout/checks/pages'
import { isBlocked } from '../../../ci/rollout/checks/requests'
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

  it('labels each row with its kind and text', () => {
    const [row] = contrastRows([raw({ kind: 'banner', label: 'Neka' })])
    expect(row).toMatchObject({ kind: 'banner', button: 'Neka' })
    expect(row!.ratio).toBeCloseTo(21, 5)
  })
})
