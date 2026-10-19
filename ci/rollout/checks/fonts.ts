// The self-hosted fonts check (site-factory#220): verify step 8 on a branch with the tool's
// src/styles/fonts.css, and live on a main that has it.
//
//   a  dist      no fonts.googleapis.com / fonts.gstatic.com in the built dist/, outside CSS and
//                HTML comments (fonts.css's own header names the css2 URL)
//   b  requests  every page at 360 and 1280 px: no request to those hosts (blocked and counted in
//                local runs, counted live), every /fonts/*.woff2 answered 200
//   c  faces     every family of fonts.css that a visible element renders with has its face (the
//                one CSS font matching picks for the element's weight and style) loaded in
//                document.fonts; main is not compared, since Google is blocked here
//   d  coverage  every character the pages show in a family of fonts.css (DOM text, hidden
//                elements included) falls in that family's kept unicode-ranges. When Google's css2
//                answer is at hand, a character outside every face Google has for the family is
//                noted, not failed: main showed it in a fallback font too. The strings of the
//                shipped JS and JSON (in the body's family of `/`) are only noted: a library string
//                may never be shown, and wire could not change it anyway.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { type Face, parseUnicodeRange, uPlus } from '../wire/fonts-css'
import { freshPage, open } from './requests'

/** fonts.googleapis.com and fonts.gstatic.com. */
export function isGoogleFonts(url: string): boolean {
  try {
    return /^fonts\.(?:googleapis|gstatic)\.com$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

const HOSTS = /fonts\.(?:googleapis|gstatic)\.com/i

/** A face declared in fonts.css. */
export interface DeclaredFace {
  family: string
  style: string
  /** [lo, hi]; a static weight has lo === hi. */
  weight: [number, number]
  ranges: [number, number][]
  src: string
  subset: string
}

const ALL: [number, number][] = [[0, 0x10ffff]]
const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, '')
const key = (family: string): string => unquote(family).toLowerCase()
const property = (block: string, name: string): string | null => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, 'i').exec(block)?.[1]?.trim() ?? null

/** `400`, `400 700`, `bold`: [lo, hi]. */
export function parseWeight(value: string | null): [number, number] {
  const words = (value ?? '400').trim().split(/\s+/).map((w) => (w === 'normal' ? 400 : w === 'bold' ? 700 : Number(w)))
  const nums = words.filter((n) => Number.isFinite(n))
  if (nums.length === 0) return [400, 400]
  return [Math.min(...nums), Math.max(...nums)]
}

/** Every `@font-face` of a fonts.css, with the subset comment above it (comments otherwise ignored). */
export function parseFontsCss(css: string): DeclaredFace[] {
  const out: DeclaredFace[] = []
  for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const block = m[0]
    const family = property(block, 'font-family')
    if (!family) continue
    const subset = /\/\*\s*([\w-]+)\s*\*\/\s*$/.exec(css.slice(0, m.index))?.[1] ?? ''
    const range = property(block, 'unicode-range')
    out.push({
      family: unquote(family),
      style: (property(block, 'font-style') ?? 'normal').toLowerCase(),
      weight: parseWeight(property(block, 'font-weight')),
      ranges: range ? parseUnicodeRange(range) : ALL,
      src: /url\(\s*['"]?([^'")\s]+)/.exec(block)?.[1] ?? '',
      subset,
    })
  }
  return out
}

/** The css2 URL in the header of the tool's fonts.css (`Generated from <url>`), or null. */
export const css2UrlOf = (css: string): string | null => /Generated from (https:\/\/fonts\.googleapis\.com\/css2\?\S+)/.exec(css)?.[1] ?? null

/** One element's face as the browser computes it: the first family of its font-family list. */
export interface UsedFace {
  family: string
  weight: number
  style: string
}

export interface LoadedFace {
  family: string
  style: string
  weight: string
  status: string
}

/** One page at one width. */
export interface FontsPage {
  path: string
  width: number
  /** Requests to fonts.googleapis.com / fonts.gstatic.com (blocked in local runs, so attempts). */
  google: string[]
  /** How many of those the browser aborted (blocked locally: net::ERR_BLOCKED_BY_CLIENT). */
  googleAborted?: number
  /** Every same-origin /fonts/*.woff2 answer; status 0 for a request that failed. */
  woff2: { url: string; status: number }[]
  /** document.fonts after document.fonts.ready. */
  loaded: LoadedFace[]
  /** The faces visible elements with text render with (distinct). */
  used: UsedFace[]
  /** The characters of every text node per first family of its element, hidden ones included. */
  chars: Record<string, string>
  /** The first family of body's font-family. */
  bodyFamily: string
}

// Runs in the page: what is loaded, what is used, which characters each family shows.
const PAGE_FONTS = `(async () => {
  await document.fonts.ready
  const first = (list) => (list.split(',')[0] || '').trim().replace(/^['"]|['"]$/g, '')
  const loaded = [...document.fonts].map((f) => ({ family: f.family.replace(/^['"]|['"]$/g, ''), style: f.style, weight: String(f.weight), status: f.status }))
  const used = new Map()
  const chars = {}
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD'])
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    if (!el || skip.has(el.tagName) || el.closest('script,style,noscript,template')) continue
    const text = n.nodeValue || ''
    if (!text.trim()) continue
    const cs = getComputedStyle(el)
    const family = first(cs.fontFamily)
    chars[family] = (chars[family] || '') + text
    if (el.getClientRects().length > 0 && cs.visibility !== 'hidden') {
      const weight = Number(cs.fontWeight) || 400
      const style = cs.fontStyle.startsWith('oblique') ? 'oblique' : cs.fontStyle
      used.set(family + '|' + weight + '|' + style, { family, weight, style })
    }
  }
  for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    const family = first(getComputedStyle(el).fontFamily)
    chars[family] = (chars[family] || '') + el.getAttribute('placeholder')
  }
  return { loaded, used: [...used.values()], chars, bodyFamily: first(getComputedStyle(document.body).fontFamily) }
})()`

const sameOriginWoff2 = (url: string, base: string): boolean => {
  try {
    const u = new URL(url)
    return u.origin === new URL(base).origin && /^\/fonts\/[^/]+\.woff2$/.test(u.pathname)
  } catch {
    return false
  }
}

/**
 * Opens every path at every width in a fresh context. `block` (local runs) aborts every Google
 * Fonts request, so nothing is sent, and counts it; live runs only count. `stub` as checkRequests.
 */
export async function checkFonts(
  browser: Browser,
  base: string,
  paths: string[],
  opts: { widths?: number[]; stub: boolean; block: boolean },
): Promise<FontsPage[]> {
  const out: FontsPage[] = []
  for (const path of paths) {
    for (const width of opts.widths ?? [360, 1280]) {
      const { context, page } = await freshPage(browser, opts.stub, { width, height: 800 })
      try {
        if (opts.block) await context.route((url) => isGoogleFonts(url.href), (route) => route.abort('blockedbyclient'))
        const google: string[] = []
        let googleAborted = 0
        const woff2: { url: string; status: number }[] = []
        page.on('request', (r) => {
          if (isGoogleFonts(r.url())) google.push(r.url())
        })
        page.on('response', (r) => {
          if (sameOriginWoff2(r.url(), base)) woff2.push({ url: r.url(), status: r.status() })
        })
        page.on('requestfailed', (r) => {
          if (isGoogleFonts(r.url()) && /ERR_BLOCKED_BY_CLIENT/.test(r.failure()?.errorText ?? '')) googleAborted++
          // A 404 also fails the request: its answer is already counted.
          if (sameOriginWoff2(r.url(), base) && !woff2.some((w) => w.url === r.url())) woff2.push({ url: r.url(), status: 0 })
        })
        await open(page, base, path)
        const got = (await (page as Page).evaluate(PAGE_FONTS)) as Omit<FontsPage, 'path' | 'width' | 'google' | 'woff2'>
        out.push({ path, width, google, ...(opts.block ? { googleAborted } : {}), woff2, ...got })
      } finally {
        await context.close()
      }
    }
  }
  return out
}

const STYLE_ORDER: Record<string, string[]> = {
  italic: ['italic', 'oblique', 'normal'],
  oblique: ['oblique', 'italic', 'normal'],
  normal: ['normal', 'oblique', 'italic'],
}

/** The faces of `faces` (one family) CSS font matching picks for `weight` and `style` (CSS Fonts 4, §5.2). */
export function matchFace(faces: DeclaredFace[], weight: number, style: string): DeclaredFace[] {
  let pool: DeclaredFace[] = []
  for (const s of STYLE_ORDER[style] ?? STYLE_ORDER['normal']!) {
    pool = faces.filter((f) => f.style === s)
    if (pool.length) break
  }
  if (pool.length === 0) return []
  const within = pool.filter((f) => f.weight[0] <= weight && weight <= f.weight[1])
  if (within.length) return within
  const below = (f: DeclaredFace) => f.weight[1] < weight
  const above = (f: DeclaredFace) => f.weight[0] > weight
  const nearestBelow = () => {
    const c = pool.filter(below)
    if (!c.length) return []
    const best = Math.max(...c.map((f) => f.weight[1]))
    return c.filter((f) => f.weight[1] === best)
  }
  const nearestAbove = (limit = Infinity) => {
    const c = pool.filter((f) => above(f) && f.weight[0] <= limit)
    if (!c.length) return []
    const best = Math.min(...c.map((f) => f.weight[0]))
    return c.filter((f) => f.weight[0] === best)
  }
  let order: (() => DeclaredFace[])[]
  if (weight >= 400 && weight <= 500) order = [() => nearestAbove(500), nearestBelow, () => nearestAbove()]
  else if (weight < 400) order = [nearestBelow, () => nearestAbove()]
  else order = [() => nearestAbove(), nearestBelow]
  for (const step of order) {
    const hit = step()
    if (hit.length) return hit
  }
  return []
}

const sameWeight = (loaded: string, w: [number, number]): boolean => {
  const [lo, hi] = parseWeight(loaded)
  return lo === w[0] && hi === w[1]
}

/** Checks b and c on one page: lines, and whether it passes. */
export function judgeFontsPage(p: FontsPage, declared: DeclaredFace[]): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  const at = `${p.path} ${p.width}px`
  let ok = true
  if (p.google.length) {
    ok = false
    lines.push(`${at}: ${p.google.length} request(s) to Google Fonts`, ...[...new Set(p.google)].slice(0, 5).map((u) => `  GOOGLE ${u.slice(0, 160)}`))
  }
  const bad = p.woff2.filter((w) => w.status !== 200)
  if (bad.length) {
    ok = false
    lines.push(`${at}: /fonts/ woff2 not 200:`, ...bad.map((w) => `  ${w.status || 'failed'} ${w.url}`))
  }
  const families = new Map<string, DeclaredFace[]>()
  for (const f of declared) families.set(key(f.family), [...(families.get(key(f.family)) ?? []), f])
  const missing: string[] = []
  for (const u of p.used) {
    const faces = families.get(key(u.family))
    if (!faces) continue
    const want = matchFace(faces, u.weight, u.style)
    const has = p.loaded.some((l) => l.status === 'loaded' && key(l.family) === key(u.family) && want.some((f) => f.style === l.style && sameWeight(l.weight, f.weight)))
    if (!has) missing.push(`${u.family} ${u.weight} ${u.style} (face ${want[0] ? `${want[0].style} ${want[0].weight.join('-')}` : 'none'} not loaded)`)
  }
  if (missing.length) {
    ok = false
    lines.push(`${at}: renders with a face of fonts.css that is not loaded:`, ...missing.map((m) => `  ${m}`))
  }
  const loaded = p.loaded.filter((l) => l.status === 'loaded' && families.has(key(l.family)))
  if (ok) lines.push(`${at}: ok (google 0, woff2 ${p.woff2.length}×200, loaded ${[...new Set(loaded.map((l) => `${l.family} ${l.weight} ${l.style}`))].join(', ') || 'none of fonts.css'})`)
  return { ok, lines }
}

const covers = (ranges: [number, number][], cp: number): boolean => ranges.some(([a, b]) => a <= cp && cp <= b)
/** Characters no font draws as a glyph of its own: controls, whitespace, the BOM, joiners. */
const invisible = (cp: number): boolean => cp < 0x21 || (cp >= 0x7f && cp <= 0xa0) || cp === 0xad || cp === 0xfeff || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xd800 && cp <= 0xdfff)

export interface Coverage {
  /** Characters of a family that its kept faces do not cover (and Google's do, when known). */
  missing: { family: string; codePoints: number[]; from: string[] }[]
  /** Characters outside every face Google has for the family: a fallback on main too. */
  notes: string[]
}

const show = (cps: number[]): string => cps.slice(0, 20).map((cp) => `${uPlus(cp)} ${String.fromCodePoint(cp)}`).join(', ') + (cps.length > 20 ? `, … (${cps.length})` : '')

/**
 * Check d. `texts`: per family (as the page names it), the characters shown and where. Families not
 * in fonts.css are not ours. `google`: Google's whole css2 answer for the URL, when at hand.
 */
export function checkCoverage(texts: { family: string; text: string; from: string }[], declared: DeclaredFace[], google: Face[] | null): Coverage {
  const kept = new Map<string, [number, number][]>()
  const names = new Map<string, string>()
  for (const f of declared) {
    kept.set(key(f.family), [...(kept.get(key(f.family)) ?? []), ...f.ranges])
    names.set(key(f.family), f.family)
  }
  const offered = new Map<string, [number, number][]>()
  for (const f of google ?? []) offered.set(key(f.family), [...(offered.get(key(f.family)) ?? []), ...f.ranges])
  const miss = new Map<string, Map<number, Set<string>>>()
  const outside = new Map<string, Set<number>>()
  for (const { family, text, from } of texts) {
    const k = key(family)
    const ranges = kept.get(k)
    if (!ranges) continue
    for (const c of text) {
      const cp = c.codePointAt(0)!
      if (invisible(cp) || covers(ranges, cp)) continue
      if (google && !covers(offered.get(k) ?? [], cp)) {
        outside.set(k, (outside.get(k) ?? new Set()).add(cp))
        continue
      }
      const m = miss.get(k) ?? new Map<number, Set<string>>()
      m.set(cp, (m.get(cp) ?? new Set()).add(from))
      miss.set(k, m)
    }
  }
  return {
    missing: [...miss].map(([k, m]) => {
      const codePoints = [...m.keys()].sort((a, b) => a - b)
      return { family: names.get(k)!, codePoints, from: [...new Set([...m.values()].flatMap((s) => [...s]))].sort().slice(0, 10) }
    }),
    notes: [...outside].map(([k, s]) => `${names.get(k)}: ${show([...s].sort((a, b) => a - b))} not in any face Google has for it either (a fallback font on main too): not checked`),
  }
}

export const coverageLines = (c: Coverage): string[] => [
  ...c.missing.map((m) => `characters shown in ${m.family} outside its kept unicode-ranges (a fallback font would draw them): ${show(m.codePoints)}; in ${m.from.join(', ')}`),
  ...c.notes,
]

/** Every file under `dir`, relative, sorted. */
function walk(dir: string, rel = ''): string[] {
  let entries: string[]
  try {
    entries = readdirSync(join(dir, rel))
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries.sort()) {
    const p = rel ? `${rel}/${e}` : e
    const st = statSync(join(dir, p))
    if (st.isDirectory()) out.push(...walk(dir, p))
    else out.push(p)
  }
  return out
}

const TEXT = /\.(?:html?|css|js|mjs|cjs|json|xml|txt|svg|webmanifest|map)$/i

/** Check a: files in `dist` naming a Google Fonts host, outside CSS comments (and HTML comments). */
export function distMentions(dist: string): string[] {
  const out: string[] = []
  for (const file of walk(dist)) {
    if (!TEXT.test(file) || file.endsWith('.map')) continue
    let text = readFileSync(join(dist, file), 'utf8')
    if (text.includes('\u0000')) continue
    if (/\.css$/i.test(file)) text = text.replace(/\/\*[\s\S]*?\*\//g, '')
    if (/\.html?$/i.test(file)) {
      text = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open: string, css: string, close: string) => `${open}${css.replace(/\/\*[\s\S]*?\*\//g, '')}${close}`)
    }
    const m = HOSTS.exec(text)
    if (m) out.push(`${file}: ${text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ')}`)
  }
  return out
}

/**
 * The characters of the shipped JS (literal, and `\u` escapes that are not the ends of a range like
 * `Ѐ-ӿ`) and the string values of shipped JSON, per file, for the notes of check d.
 * `dist` is what the browser gets (dist/client for a server build).
 */
export function shippedStrings(dist: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const file of walk(dist)) {
    if (/\.(?:js|mjs)$/i.test(file)) {
      const raw = readFileSync(join(dist, file), 'utf8')
      let text = raw.replace(/[\x00-\x7f]+/g, ' ')
      const escaped = raw.replace(/\\u([0-9a-f]{4})-\\u[0-9a-f]{4}|\\u\{[0-9a-f]{1,6}\}-\\u\{[0-9a-f]{1,6}\}/gi, ' ')
      for (const m of escaped.matchAll(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/gi)) {
        const cp = parseInt(m[1] ?? m[2]!, 16)
        if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) text += String.fromCodePoint(cp)
      }
      if (text.trim()) out.push({ file, text })
    } else if (/\.json$/i.test(file)) {
      let json: unknown
      try {
        json = JSON.parse(readFileSync(join(dist, file), 'utf8'))
      } catch {
        continue
      }
      const strings: string[] = []
      const visit = (v: unknown): void => {
        if (typeof v === 'string') strings.push(v)
        else if (Array.isArray(v)) v.forEach(visit)
        else if (v && typeof v === 'object') Object.values(v).forEach(visit)
      }
      visit(json)
      if (strings.length) out.push({ file, text: strings.join(' ') })
    }
  }
  return out
}

/** Check d's texts from the browser pages: per family as the page names it, hidden elements included. */
export function pageTexts(pages: FontsPage[]): { family: string; text: string; from: string }[] {
  return pages.flatMap((p) => Object.entries(p.chars).map(([family, text]) => ({ family, text, from: p.path })))
}

/** The shipped strings as texts in `/`'s body family, for checkCoverage: notes only (shippedNotes). */
export function shippedTexts(pages: FontsPage[], shipped: { file: string; text: string }[]): { family: string; text: string; from: string }[] {
  const body = pages.find((p) => p.path === '/')?.bodyFamily ?? pages[0]?.bodyFamily
  return body ? shipped.map((s) => ({ family: body, text: s.text, from: s.file })) : []
}

/** checkCoverage of the shipped strings as note lines: a library string may never be shown. */
export const shippedNotes = (c: Coverage): string[] => [
  ...c.missing.map((m) => `note: characters in the shipped JS/JSON outside ${m.family}'s kept unicode-ranges (not checked: a script string may never be shown): ${show(m.codePoints)}; in ${m.from.join(', ')}`),
  ...c.notes,
]
