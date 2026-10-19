// Self-hosts a site's Google Fonts (site-factory#220), from what detect found (`report.fonts`,
// status `wire`): one css2 URL and every place that loads it.
//
// planFonts works everything out before anything is written, text edits first (no request is made
// when they refuse), then the network: Google's css2 answer to a modern Chrome (woff2 with a
// unicode-range per subset), each woff2 file kept (see fonts-css), and each family's licence from
// the google/fonts repo. The plan is:
//   - public/fonts/<family>-<style>-<weight>-<subset>-<hash>.woff2, the bytes Google served;
//   - public/fonts/LICENSE-<family>.txt, the family's OFL.txt (or Apache LICENSE.txt, UFL.txt) as
//     google/fonts ships it, copyright line included: the OFL asks that it travel with the fonts;
//   - src/styles/fonts.css: a header naming the URL and date, then Google's @font-face blocks
//     verbatim with local urls, so every family name, weight, style and unicode-range stays;
//   - `@import "./fonts.css";` right after `@import "tailwindcss"` in the Tailwind entry, which
//     every layout already imports: bundled into the site's hashed CSS, and still an @import
//     before any rule, as CSS requires;
//   - every location removed (whole lines, with a one-line fonts comment right above them, see
//     isFontComment, and one of two blank lines around them); the two hosts cut from each CSP.
// The report must still match a fresh detect (its offsets are where the cuts go).
// Any failed request, unexpected answer, or file already there refuses the whole plan.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { detectFonts } from '../detect/fonts'
import { type AstroNode, parseAstro } from '../lib/astro-ast'
import type { SiteFiles } from '../lib/site-files'
import type { Edit, FontCsp, FontsInfo, FontsPlan } from '../types'
import { topLevelImportEnds } from './css'
import { applyEdits, eolOf } from './engine'
import { codePointsOf, type Face, fontFileName, parseCss2, selectFaces, slug, uPlus } from './fonts-css'
import { commitAllowed, recovery, startBranch, writeFiles } from './index'

export const FONTS_BRANCH = 'fonts-selfhost'
export const FONTS_COMMIT_MESSAGE = 'feat: Google Fonts från sajten själv (self-hosted)'
/** A pinned, current desktop Chrome: Google answers it with woff2 and unicode-range subsets. */
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
export const FONTS_CSS = 'src/styles/fonts.css'
export const FONTS_DIR = 'public/fonts'
const TARGET = 'google fonts'
const GOOGLE_FONTS = 'https://raw.githubusercontent.com/google/fonts/main'
const HOSTS = /fonts\.(?:googleapis|gstatic)\.com/i
/** A CSP source token for one of the two hosts, with the whitespace before it. */
const TOKEN = /\s+(?:https?:\/\/)?fonts\.(?:googleapis|gstatic)\.com\/?(?=[\s;"'`,]|$)/gi
/** An HTML comment about the fonts block it heads. */
const FONT_PHRASE = /^(?:(?:google|brand)\s+)?(?:fonts?|typsnitt|typography|typografi)\b/i
/**
 * Whether a comment's text (without its delimiters) heads the fonts block: one line, starting with
 * a fonts phrase ("Google Fonts", "Fonts: …", "Typography: …", "Typsnitt"). A multi-line comment or
 * one that merely mentions fonts ("DO NOT remove the meta viewport: the fonts…") stays.
 */
export const isFontComment = (inner: string): boolean => !/[\r\n]/.test(inner) && FONT_PHRASE.test(inner.trim()) && !OTHER_FONT_PRODUCT.test(inner)
/** Comments that name another font product are about that, not the Google Fonts block. */
const OTHER_FONT_PRODUCT = /\bfont\s*-?awesome\b|\bfontsource\b|\bicon\s*fonts?\b|\btypekit\b|\badobe\s+fonts\b/i
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

export interface FontsInput {
  /** Missing in reports stored before fonts detection. */
  fonts?: FontsInfo
  css: { entry: string | null }
}

export interface PlanFontsOptions {
  fetch?: FontFetch
  /** The date in the fonts.css header. */
  now?: Date
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

interface Span {
  start: number
  end: number
}

/** The line holding `at`: its start, its end (before the newline) and the end after the newline. */
function lineAt(text: string, at: number): { start: number; end: number; next: number } {
  const start = text.lastIndexOf('\n', at - 1) + 1
  const nl = text.indexOf('\n', at)
  return nl < 0 ? { start, end: text.length, next: text.length } : { start, end: nl, next: nl + 1 }
}

const indentOf = (line: string): number => /^[ \t]*/.exec(line)![0].length

/**
 * What to cut for `run`: just the span when it shares a line with something else; otherwise its
 * whole lines, plus one blank line when it sat between two (or between a blank line and the end
 * of a block, the frontmatter fence or the file), so no double blank line is left behind.
 */
function cutLines(text: string, run: Span): Span {
  const first = lineAt(text, run.start)
  const last = lineAt(text, Math.max(run.start, run.end - 1))
  if (text.slice(first.start, run.start).trim() !== '' || text.slice(run.end, last.end).trim() !== '') return run
  let start = first.start
  let end = last.next
  const runIndent = indentOf(text.slice(first.start, first.end))
  const prev = start > 0 ? lineAt(text, start - 1) : null
  const next = end < text.length ? lineAt(text, end) : null
  const lineText = (l: { start: number; end: number }) => text.slice(l.start, l.end)
  const blank = (l: typeof prev) => l !== null && lineText(l).trim() === ''
  const boundary = (l: typeof prev) => l === null || /^---\s*$/.test(lineText(l)) || (lineText(l).trim() !== '' && indentOf(lineText(l)) < runIndent)
  if (blank(prev) && blank(next)) end = next!.next
  else if (blank(prev) && boundary(next)) start = prev!.start
  else if (blank(next) && boundary(prev)) end = next!.next
  return { start, end }
}

function comments(root: AstroNode): Span[] {
  const out: Span[] = []
  const visit = (n: AstroNode): void => {
    if (n.type === 'comment') out.push({ start: n.start, end: n.end })
    n.children.forEach(visit)
  }
  visit(root)
  return out
}

/**
 * The cuts for one file's locations: spans with only whitespace between them become one run; in
 * an .astro file a font comment on the line(s) right above a run joins it; each run is cut by
 * cutLines.
 */
export function locationCuts(file: string, text: string, spans: (Span & { kind?: string })[]): Span[] {
  const runs: Span[] = []
  const widened = spans.map((s) => (s.kind === 'const' ? constSpan(text, s) : { start: s.start, end: s.end }))
  for (const s of widened.sort((a, b) => a.start - b.start)) {
    const last = runs.at(-1)
    if (last && s.start >= last.end && text.slice(last.end, s.start).trim() === '') last.end = Math.max(last.end, s.end)
    else runs.push({ ...s })
  }
  if (file.endsWith('.astro')) {
    const notes = comments(parseAstro(text).root)
    for (const run of runs) {
      const c = notes.find((n) => n.end <= run.start && /^[ \t]*\r?\n[ \t]*$/.test(text.slice(n.end, run.start)))
      const inner = c ? text.slice(c.start, c.end).replace(/^<!--/, '').replace(/-->$/, '') : ''
      if (c && text.slice(lineAt(text, c.start).start, c.start).trim() === '' && isFontComment(inner)) run.start = c.start
    }
  }
  return runs.map((r) => cutLines(text, r))
}

/**
 * A frontmatter const statement widened over a trailing `// note` on its last line (it explains
 * the const and goes with it) and a fonts `// …` line comment on the line right above it.
 */
function constSpan(text: string, s: Span): Span {
  let { start, end } = s
  const trailing = /^[ \t]*\/\/[^\r\n]*/.exec(text.slice(end))
  if (trailing) end += trailing[0].length
  // The contiguous `//` block right above: cut only when every line of it is a fonts comment.
  const line = lineAt(text, start)
  if (text.slice(line.start, start).trim() !== '') return { start, end }
  let top: number | null = null
  let at = line.start
  while (at > 0) {
    const prev = lineAt(text, at - 1)
    const m = /^[ \t]*\/\/(.*?)\r?$/.exec(text.slice(prev.start, prev.end))
    if (!m) break
    if (!isFontComment(m[1]!)) return { start, end }
    top = prev.start + text.slice(prev.start, prev.end).indexOf('//')
    at = prev.start
  }
  return { start: top ?? start, end }
}

/** The policy text of a CSP span: a meta's content value, a `_headers` line after its colon, a module string's content. */
function policyOf(kind: FontCsp['kind'], span: string): string {
  if (kind === 'meta') return /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(span)?.[2] ?? ''
  if (kind === 'headers') return span.slice(span.indexOf(':') + 1)
  return span.slice(1, -1)
}

/** Directive names (`connect-src`) with no source: each `;` part split on whitespace, name alone. */
const emptyDirectives = (policy: string): Set<string> =>
  new Set(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/).filter(Boolean))
      .filter((tokens) => tokens.length === 1 && /-src(?:-elem|-attr)?$/i.test(tokens[0]!))
      .map((tokens) => tokens[0]!.toLowerCase()),
  )

/** A CSP with the two hosts' source tokens cut, the rest untouched. Throws if a directive would be left empty. */
export function stripCsp(file: string, span: string, kind: FontCsp['kind']): string {
  const out = span.replace(TOKEN, '')
  const before = emptyDirectives(policyOf(kind, span))
  for (const d of emptyDirectives(policyOf(kind, out))) if (!before.has(d)) throw new Error(`${file}: Content-Security-Policy ${d} would be left with no source`)
  if (HOSTS.test(out)) throw new Error(`${file}: a Google Fonts host in the Content-Security-Policy is not a plain source token`)
  return out
}

/** The edit that adds `@import "<fonts.css>";` right after the entry's `@import "tailwindcss"`. */
function importEdit(files: SiteFiles, entry: string): Edit {
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

/** The text edits: the cuts, the CSP strips and the import. Throws with the reason. */
export function fontEdits(files: SiteFiles, fonts: FontsInfo, entry: string): Edit[] {
  const edits: Edit[] = []
  const byFile = new Map<string, Span[]>()
  for (const l of fonts.locations) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l])
  for (const [file, spans] of byFile) {
    const text = files.read(file)
    for (const cut of locationCuts(file, text, spans)) edits.push({ file, start: cut.start, end: cut.end, text: '', target: `${TARGET} (${file})` })
  }
  for (const c of fonts.csp) {
    const span = files.read(c.file).slice(c.start, c.end)
    const stripped = stripCsp(c.file, span, c.kind)
    if (stripped !== span) edits.push({ file: c.file, start: c.start, end: c.end, text: stripped, target: `${TARGET} csp (${c.file})` })
  }
  edits.push(importEdit(files, entry))
  // Overlaps would be a detect bug; refuse rather than guess.
  for (const file of new Set(edits.map((e) => e.file))) {
    const mine = edits.filter((e) => e.file === file).sort((a, b) => a.start - b.start)
    for (let i = 1; i < mine.length; i++) if (mine[i - 1]!.end > mine[i]!.start) throw new Error(`${file}: overlapping edits`)
  }
  return edits
}

async function get(fetch: FontFetch, url: string, allow404 = false): Promise<FetchAnswer | null> {
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

const decodeUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b)
const isWoff2 = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32

/** Adds `font-display: swap` before `src` where Google left it out; a value Google gave is the site's own `display=`. */
const withSwap = (block: string): string => (/font-display\s*:/.test(block) ? block : block.replace(/(\n[ \t]*)src\s*:/, '$1font-display: swap;$1src:'))

/** The plan, or refusals. Nothing is written; see the header for what it holds. */
export async function planFonts(files: SiteFiles, report: FontsInput, opts: PlanFontsOptions = {}): Promise<FontsPlan> {
  const refuse = (reason: string): FontsPlan => ({ ok: false, refusals: [{ file: '', target: TARGET, reason }] })
  const fonts = report.fonts
  if (!fonts) return refuse('the report was stored before fonts detection: run detect again')
  if (fonts.status === 'needs-human') return { ok: false, refusals: fonts.reasons.map((r) => ({ file: '', target: TARGET, reason: `needs a look: ${r}` })) }
  if (fonts.status !== 'wire' || !fonts.url) return refuse(`no Google Fonts to self-host (status ${fonts.status})`)
  if (files.exists(FONTS_CSS)) return refuse(`${FONTS_CSS} already exists`)
  if (files.list(`${FONTS_DIR}/**`).length > 0) return refuse(`${FONTS_DIR}/ already exists`)
  const entry = report.css.entry
  if (!entry) return refuse('no Tailwind CSS entry to import the self-hosted fonts from')
  const url = fonts.url
  if (!/^https:\/\/fonts\.googleapis\.com\/css2\?/.test(url)) return refuse(`not a css2 URL: ${url}`)
  // The edits cut at the report's offsets, so they are only right for the files detect read. A
  // fresh detect must reproduce report.fonts exactly; otherwise the checkout moved on (the banner
  // merged, a hand edit) and the report, which is what was reviewed, is stale.
  let fresh: FontsInfo
  try {
    fresh = detectFonts(files, entry)
  } catch (e) {
    return refuse(`detect failed on the checkout: ${(e as Error).message}`)
  }
  if (!isDeepStrictEqual(fresh, fonts)) return refuse('report.fonts no longer matches the checkout: run detect again')

  let edits: Edit[]
  try {
    edits = fontEdits(files, fonts, entry)
  } catch (e) {
    return refuse((e as Error).message)
  }

  const fetch = opts.fetch ?? httpFetch
  try {
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
      ok: true,
      url,
      edits,
      newFiles: [{ path: FONTS_CSS, text: `${header}${body}\n` }, ...licences.map((l) => ({ path: l.path, text: l.text }))],
      fontFiles,
      notes: [
        `google fonts: ${kept.length} of ${faces.length} faces, ${fontFiles.length} woff2 files (${(bytes / 1024).toFixed(1)} kB), ${families.length} ${families.length === 1 ? 'family' : 'families'}`,
        `  subsets: ${subsets}; left out: ${dropped.join(', ') || 'none'}`,
        `  licences: ${licences.map((l) => `${l.family} ${l.licence}`).join(', ')}`,
      ],
    }
  } catch (e) {
    return refuse((e as Error).message)
  }
}

/** A file the fonts plan writes: `before` is null for a new one; `after` is bytes for a woff2. */
export interface FontsFile {
  path: string
  before: string | null
  after: string | Uint8Array
}

/**
 * Each file the plan writes, from the files as detect read them (`read`). `base` are edits applied
 * in the same files before the fonts (the banner's, for the second commit on consent-banner): a
 * file's `before` is then the banner's version and its `after` both together. Throws on overlap.
 */
export function fontsFiles(read: (path: string) => string, plan: Extract<FontsPlan, { ok: true }>, base: readonly Edit[] = []): FontsFile[] {
  const out: FontsFile[] = []
  for (const path of [...new Set(plan.edits.map((e) => e.file))]) {
    const original = read(path)
    const mine = plan.edits.filter((e) => e.file === path)
    const theirs = base.filter((e) => e.file === path)
    // The fonts edits first: at one offset, `@import "./fonts.css"` goes before the banner's @source.
    out.push({ path, before: applyEdits(original, theirs), after: applyEdits(original, [...mine, ...theirs]) })
  }
  for (const f of plan.newFiles) out.push({ path: f.path, before: null, after: f.text })
  for (const f of plan.fontFiles) out.push({ path: f.path, before: null, after: f.bytes })
  return out
}

/** Why the checkout at `root` cannot take the fonts (fonts.css or public/fonts/ there), or null. */
export function fontsTargetsTaken(root: string): string | null {
  if (existsSync(join(root, FONTS_CSS))) return `${FONTS_CSS} already exists, nothing written`
  if (existsSync(join(root, FONTS_DIR))) return `${FONTS_DIR}/ already exists, nothing written`
  return null
}

/**
 * Writes `files` and commits them alone (FONTS_COMMIT_MESSAGE). With `branch`, first switches to a
 * new branch from origin/main (startBranch refuses a dirty or diverged checkout, or a branch that
 * exists). With `onto`, the commit goes on top of that branch's own commit (wire --fonts: the
 * banner). Every edited file must still be on disk as planned (`before`), or nothing is written.
 * Throws with the reason; after a failure past the first write, with how to recover.
 */
export function commitFonts(dir: string, files: readonly FontsFile[], opts: { branch?: string; onto?: string } = {}): void {
  const root = resolve(dir)
  // After the banner commit (wire --fonts) every failure, a check or a write, leaves that commit.
  const onto = opts.onto
    ? `the banner is committed on ${opts.onto}, the fonts are not: git reset --hard && git clean -fd drops the fonts and keeps the banner commit (self-host them later with run.ts fonts); to start over: git reset --hard && git clean -fd && git switch main && git branch -D ${opts.onto}`
    : null
  const fail = (message: string): never => {
    throw new Error(onto ? `${message}\n${onto}` : message)
  }
  const taken = fontsTargetsTaken(root)
  if (taken) fail(taken)
  for (const f of files) {
    if (f.before !== null && readFileSync(join(root, f.path), 'utf8') !== f.before) fail(`${f.path} changed since it was planned, nothing written: run detect and the command again`)
  }
  if (opts.branch) startBranch(root, opts.branch)
  try {
    writeFiles(root, files.map((f) => ({ path: f.path, data: f.after })))
    commitAllowed(root, new Set(files.map((f) => f.path)), FONTS_COMMIT_MESSAGE)
  } catch (e) {
    const how = onto ?? recovery(opts.branch ?? execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim())
    throw new Error(`${(e as Error).message}\n${how}`)
  }
}
