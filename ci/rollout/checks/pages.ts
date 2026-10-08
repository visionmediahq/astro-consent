// Which pages verify and live check (spec C3 step 3): every built page, plus a missing URL so the
// 404 page is checked too. Detect only reads source, so this reads the built site instead.
import { existsSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { parse } from 'node-html-parser'

/** A path no site has: the request lands on the site's 404 page. */
export const MISSING_PREFIX = '/finns-inte-'

/**
 * Ruling 26: a CMS admin shell, not a visitor page: no banner, no PrivacyLinks. Covers
 * src/pages/admin/ and Decap's usual public/admin/index.html (built to dist/admin/).
 */
export const isCmsAdminRoute = (path: string): boolean => path === '/admin' || path.startsWith('/admin/')

/** Upper bound for the SSR crawl: a link loop or a calendar must not keep it going for ever. */
const MAX_CRAWL = 200

const missingPath = (): string => MISSING_PREFIX + Math.random().toString(36).slice(2, 10)

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.split(sep).join('/'))
}

/**
 * dist/**\/*.html as URL paths: index.html → '/', om/index.html → '/om/', kontakt.html → '/kontakt'.
 * Static output with an adapter (Astro 5+) builds the pages to dist/client/ beside dist/server/:
 * those are listed from dist/client/, so no page shows up as /client/….
 */
function staticPages(distDir: string): string[] {
  const client = join(distDir, 'client')
  const root = existsSync(join(distDir, 'server', 'entry.mjs')) && existsSync(client) ? client : distDir
  const paths = htmlFiles(root)
    .filter((f) => !/^(404|500)\.html$/.test(f) && !f.startsWith('_astro/'))
    .map((f) => '/' + (f === 'index.html' ? '' : f.endsWith('/index.html') ? f.slice(0, -'index.html'.length) : f.slice(0, -'.html'.length)))
  return [...new Set(paths)].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)))
}

/** Same-origin page links in `html`, as paths without hash or query, deduped in document order. */
export function extractLinks(html: string, pageUrl: string, base: string): string[] {
  const origin = new URL(base).origin
  const out = new Set<string>()
  for (const a of parse(html).querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')?.trim()
    if (!href || href.startsWith('#')) continue
    let url: URL
    try {
      url = new URL(href, pageUrl)
    } catch {
      continue
    }
    if (url.origin !== origin || !/^https?:$/.test(url.protocol)) continue
    // A file (pdf, image, …) is not a page; .html is.
    const last = url.pathname.split('/').at(-1) ?? ''
    if (/\.[a-z0-9]+$/i.test(last) && !/\.html?$/i.test(last)) continue
    out.add(url.pathname)
  }
  return [...out]
}

function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'))
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
    if (!res.ok || !(res.headers.get('content-type') ?? '').match(/html|xml/)) return null
    return await res.text()
  } catch {
    return null
  }
}

/**
 * Page paths from /sitemap-index.xml or /sitemap.xml (one level of nesting). Sitemaps carry the
 * production domain: only their paths are kept, and nested sitemaps are fetched from `base` too,
 * so a local run never fetches from the live site.
 */
async function sitemapPages(base: string): Promise<string[]> {
  const origin = new URL(base).origin
  const out = new Set<string>()
  for (const name of ['/sitemap-index.xml', '/sitemap.xml']) {
    const xml = await fetchText(origin + name)
    if (!xml) continue
    const locs = sitemapLocs(xml)
    const nested = xml.includes('<sitemapindex') ? locs : []
    const pages = xml.includes('<sitemapindex') ? [] : locs
    for (const sub of nested) {
      let subUrl: string
      try {
        subUrl = origin + new URL(sub).pathname
      } catch {
        continue
      }
      const subXml = await fetchText(subUrl)
      if (subXml) pages.push(...sitemapLocs(subXml))
    }
    for (const loc of pages) {
      try {
        out.add(new URL(loc).pathname)
      } catch {
        // not a URL
      }
    }
    if (out.size > 0) break
  }
  return [...out]
}

/**
 * A crawled path: its HTML, or `file` when it answers 2xx with anything but HTML (an endpoint
 * serving a PDF or JSON without an extension: opening it in a browser starts a download). A path
 * that errors or does not answer stays a page, so a broken link is still checked.
 */
async function fetchPage(url: string): Promise<string | 'file' | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    if (!/html/.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel()
      return 'file'
    }
    return await res.text()
  } catch {
    return null
  }
}

/** Every page reachable by same-origin links from '/', plus the sitemap's pages. */
async function crawl(base: string): Promise<string[]> {
  const seen = new Set<string>(['/'])
  const files = new Set<string>()
  const queue = ['/']
  for (const p of await sitemapPages(base)) if (!seen.has(p)) (seen.add(p), queue.push(p))
  for (let i = 0; i < queue.length && seen.size < MAX_CRAWL; i++) {
    const url = new URL(queue[i]!, base).href
    const html = await fetchPage(url)
    if (html === 'file') files.add(queue[i]!)
    if (!html || html === 'file') continue
    for (const p of extractLinks(html, url, base)) {
      if (seen.size >= MAX_CRAWL) break
      if (!seen.has(p)) (seen.add(p), queue.push(p))
    }
  }
  return [...seen].filter((p) => !files.has(p))
}

/**
 * The pages to check on `base`: `dist/**\/*.html` for static output (`distDir` required), a crawl
 * for `ssr` output. Always ends with one missing URL for the 404 page.
 */
export async function listPages(base: string, opts: { distDir?: string; ssr: boolean }): Promise<string[]> {
  let pages: string[]
  if (opts.ssr) pages = await crawl(base)
  else {
    if (!opts.distDir) throw new Error('listPages: a static site needs distDir')
    pages = staticPages(opts.distDir)
  }
  return [...pages, missingPath()]
}
