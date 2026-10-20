// What self-hosting a Google Fonts stylesheet needs, without detect, git or any edit to the site's
// markup: Google's css2 answer to a modern Chrome, each woff2 file kept, each family's licence from
// google/fonts, and the fonts.css that ties them together. `planFonts` (wire, fonts) builds on it;
// so does `fonts-files`, which site-factory's Builder runs for the sites it generates (#175).
//
// Imports node built-ins and relative files that are themselves free of packages only, so the
// Builder can run it with tsx alone (tests/unit/rollout/fonts-files.test.ts pins this).
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { Edit } from '../types'
import type { SiteFiles } from '../lib/site-files'
import { topLevelImportEnds } from './css-imports'
import { eolOf } from './engine'
import { codePointsOf, type Face, fontFileName, parseCss2, selectFaces, slug, uPlus } from './fonts-css'

/** A pinned, current desktop Chrome: Google answers it with woff2 and unicode-range subsets. */
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
export const FONTS_CSS = 'src/styles/fonts.css'
export const FONTS_DIR = 'public/fonts'
export const TARGET = 'google fonts'
const GOOGLE_FONTS = 'https://raw.githubusercontent.com/google/fonts/main'
export const HOSTS = /fonts\.(?:googleapis|gstatic)\.com/i
const SV_JSON = join(import.meta.dirname, '../../../src/text/sv.json')

export interface FetchAnswer {
  status: number
  contentType: string
  body: Uint8Array
}
/** The network, injectable: tests answer from recordings. */
export type FontFetch = (url: string, headers: Record<string, string>) => Promise<FetchAnswer>

export const httpFetch: FontFetch = async (url, headers) => {
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: new Uint8Array(await res.arrayBuffer()) }
}

export type Licence = 'OFL' | 'Apache-2.0' | 'UFL'
const LICENCE_TEXT: Record<Licence, RegExp> = { OFL: /SIL Open Font License/i, 'Apache-2.0': /Apache License/, UFL: /Ubuntu Font Licen[cs]e/i }

/** Where google/fonts keeps a family's licence, in the order tried: ofl/, apache/, ufl/. */
export function licenceUrls(family: string): { licence: Licence; url: string }[] {
  const dir = family.toLowerCase().replace(/[^a-z0-9]/g, '')
  return [
    { licence: 'OFL', url: `${GOOGLE_FONTS}/ofl/${dir}/OFL.txt` },
    { licence: 'Apache-2.0', url: `${GOOGLE_FONTS}/apache/${dir}/LICENSE.txt` },
    { licence: 'UFL', url: `${GOOGLE_FONTS}/ufl/${dir}/UFL.txt` },
  ]
}

/** Every code point the site's own source may show (src/**, binary files skipped), and the banner's. */
export function siteCodePoints(files: SiteFiles): Set<number> {
  const out = new Set<number>()
  const texts = files
    .list('src/**')
    .map((f) => files.read(f))
    .filter((t) => !t.includes('\u0000'))
  texts.push(readFileSync(SV_JSON, 'utf8'))
  for (const t of texts) for (const cp of codePointsOf(t)) out.add(cp)
  return out
}

/** The edit that adds `@import "<fonts.css>";` right after the entry's `@import "tailwindcss"`. */
export function importEdit(files: SiteFiles, entry: string): Edit {
  const css = files.read(entry)
  const blanked = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  const ends = new Set(topLevelImportEnds(css))
  const hits = [...blanked.matchAll(/@import\s+(?:url\(\s*)?(["'])tailwindcss\1\s*\)?[^;{}]*;/g)].filter((m) => ends.has(m.index + m[0].length))
  if (hits.length !== 1) throw new Error(`${entry}: found ${hits.length} top-level @import "tailwindcss", expected exactly 1`)
  const end = hits[0]!.index + hits[0]![0].length
  // A comment after the statement on the same line stays with it.
  const rest = /^[ \t]*(?:\/\*[^\n]*?\*\/[ \t]*)*(?=\r?\n|$)/.exec(css.slice(end))
  const at = end + (rest ? rest[0].length : 0)
  const rel = posix.relative(posix.dirname(entry), FONTS_CSS)
  return { file: entry, start: at, end: at, text: `${eolOf(css)}@import "${rel.startsWith('.') ? rel : `./${rel}`}";`, target: `${TARGET} @import (${entry})` }
}

export async function get(fetch: FontFetch, url: string, allow404 = false): Promise<FetchAnswer | null> {
  let res: FetchAnswer
  try {
    res = await fetch(url, { 'User-Agent': CHROME_UA })
  } catch (e) {
    throw new Error(`${url}: request failed (${e instanceof Error ? e.message : String(e)})`)
  }
  if (allow404 && res.status === 404) return null
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}`)
  return res
}

export const decodeUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b)
const isWoff2 = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32

/** Adds `font-display: swap` before `src` where Google left it out; a value Google gave is the site's own `display=`. */
const withSwap = (block: string): string => (/font-display\s*:/.test(block) ? block : block.replace(/(\n[ \t]*)src\s*:/, '$1font-display: swap;$1src:'))

export interface PlanFontsOptions {
  fetch?: FontFetch
  /** The date in the fonts.css header. */
  now?: Date
}

/** What self-hosting a css2 URL produces; `newFiles` are text, `fontFiles` the woff2 bytes Google served. */
export interface SelfHosted {
  newFiles: { path: string; text: string }[]
  fontFiles: { path: string; bytes: Uint8Array }[]
  /** One line each: subsets kept and left out, files, bytes. */
  notes: string[]
}

/**
 * Fetches `url` (a Google Fonts css2 URL) and everything it names, and returns the files to write:
 * public/fonts/*.woff2, one LICENSE-<family>.txt each and src/styles/fonts.css. `files` is the
 * site, whose own text decides which subsets are kept. Throws, with the reason, on any failed
 * request, unexpected answer or family without a licence; nothing is written either way.
 */
export async function selfHostFonts(files: SiteFiles, url: string, opts: PlanFontsOptions = {}): Promise<SelfHosted> {
  const fetch = opts.fetch ?? httpFetch
  const css2 = decodeUtf8((await get(fetch, url))!.body)
  let faces: Face[]
  try {
    faces = parseCss2(css2)
  } catch (e) {
    throw new Error(`${url}: ${(e as Error).message}`)
  }
  for (const family of new Set(faces.map((f) => f.family))) {
    if (!faces.some((f) => f.family === family && f.subset === 'latin')) throw new Error(`${url}: no latin subset for ${family}`)
  }
  const { kept, extra, dropped } = selectFaces(faces, siteCodePoints(files))

  // One download per woff2 URL: a variable font serves several weights from one file.
  const srcs = [...new Set(kept.map((f) => f.src))]
  const bodies = await Promise.all(
    srcs.map(async (src) => {
      const body = (await get(fetch, src))!.body
      if (!isWoff2(body)) throw new Error(`${src}: not a woff2 file`)
      return body
    }),
  )
  const local = new Map<string, string>()
  const fontFiles: { path: string; bytes: Uint8Array }[] = []
  srcs.forEach((src, i) => {
    const users = kept.filter((f) => f.src === src)
    const f = users[0]!
    const name = fontFileName(f.family, f.style, users.map((u) => u.weight), f.subset, bodies[i]!)
    local.set(src, `/fonts/${name}`)
    if (!fontFiles.some((x) => x.path === `${FONTS_DIR}/${name}`)) fontFiles.push({ path: `${FONTS_DIR}/${name}`, bytes: bodies[i]! })
  })

  const families = [...new Set(kept.map((f) => f.family))]
  const licences: { family: string; licence: Licence; path: string; text: string }[] = []
  for (const family of families) {
    let found: (typeof licences)[number] | null = null
    for (const { licence, url: at } of licenceUrls(family)) {
      const res = await get(fetch, at, true)
      if (!res) continue
      const text = decodeUtf8(res.body)
      if (!LICENCE_TEXT[licence].test(text)) throw new Error(`${at} is not the ${licence} text`)
      if (HOSTS.test(text)) throw new Error(`${at} names a Google Fonts host`)
      found = { family, licence, path: `${FONTS_DIR}/LICENSE-${slug(family)}.txt`, text }
      break
    }
    if (!found) throw new Error(`no licence for ${family} in google/fonts (ofl/, apache/, ufl/)`)
    licences.push(found)
  }

  const base = ['latin', 'latin-ext'].filter((s) => kept.some((f) => f.subset === s))
  const shown = (cps: number[]) => (cps.length > 5 ? `${cps.slice(0, 5).map(uPlus).join(' ')} …` : cps.map(uPlus).join(' '))
  const subsets = [...base, ...extra.map((e) => `${e.subset} (${shown(e.codePoints)})`)].join(', ')
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10)
  const header = [
    '/*',
    ` * Generated from ${url}`,
    ` * on ${date} by the astro-consent rollout tool: Google's own faces, served from /fonts/.`,
    ` * Subsets: ${subsets}. Left out: ${dropped.join(', ') || 'none'}.`,
    ` * Licences: ${licences.map((l) => `/${l.path.slice('public/'.length)} (${l.licence})`).join(', ')}.`,
    ' */',
    '',
  ].join('\n')
  const body = kept.map((f) => `/* ${f.subset} */\n${withSwap(f.block.replace(f.src, local.get(f.src)!))}`).join('\n')
  const bytes = fontFiles.reduce((n, f) => n + f.bytes.length, 0)
  return {
    newFiles: [{ path: FONTS_CSS, text: `${header}${body}\n` }, ...licences.map((l) => ({ path: l.path, text: l.text }))],
    fontFiles,
    notes: [
      `google fonts: ${kept.length} of ${faces.length} faces, ${fontFiles.length} woff2 files (${(bytes / 1024).toFixed(1)} kB), ${families.length} ${families.length === 1 ? 'family' : 'families'}`,
      `  subsets: ${subsets}; left out: ${dropped.join(', ') || 'none'}`,
      `  licences: ${licences.map((l) => `${l.family} ${l.licence}`).join(', ')}`,
    ],
  }
}
