// Detects how a site loads Sentry's browser bundle, which its layout uses for GlitchTip error
// reporting (#93): from jsDelivr (`@sentry/browser@8/build/bundle.min.js`, which is a 404), from
// browser.sentry-cdn.com, from a local copy, or not at all.
//
// A load the tool can self-host is one of two shapes in an .astro file:
//   - `<script src="<CDN bundle>">`, any other attributes (is:inline, defer, async, id, onload,
//     data-*); its `integrity` and `crossorigin` go with the CDN;
//   - an inline script that builds the element: `x.src = '<CDN bundle>'`, with optional
//     `x.integrity = '…'` and `x.crossOrigin = '…'` lines, which go with the CDN too.
// The URL must be Sentry's plain `bundle.min.js` of major 8. Every other mention of either CDN with
// a path (a const, a fetch, another file, another bundle, another major) makes the site
// needs-human, as does a file that names one and does not parse: a miss here would leave a CDN
// load before consent. Mentions in HTML comments, and in JS comments in the frontmatter or a
// script, are not loads; a bare origin in text (a CSP's `https://browser.sentry-cdn.com`) is not a
// mention. A `<script src>` must be `is:inline`: Astro would process a local src without it.
//
// Resource hints connect before consent too (review of #126): a `<link rel="preconnect">` or
// `rel="dns-prefetch"` to a Sentry CDN host goes with the loads (`hints`, cut by wire), and so does
// one to cdn.jsdelivr.net when nothing but Sentry comes from jsDelivr. Any other element whose
// attribute is a Sentry CDN URL (a preload, a stylesheet, an image; bare origin included, a CSP
// `<meta>` excepted), and a hint with no CDN load beside it, is a reason.
import { type AstroAttribute, type AstroNode, elements, parseAstro } from '../lib/astro-ast'
import { judgeBundleUrl, SENTRY_BUNDLE_HEADER, SENTRY_CDN_MENTION, sentryCdnOf } from '../lib/sentry'
import type { SiteFiles } from '../lib/site-files'
import type { SentryHint, SentryInfo, SentryLoader } from '../types'
import { BINARY } from './scripts'

interface Span {
  start: number
  end: number
}

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length

/** `//` and `/* … *\/` comments in JS source `text[from, to)`, strings and template literals skipped. */
export function jsComments(text: string, from: number, to: number): Span[] {
  const out: Span[] = []
  let i = from
  while (i < to) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < to && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      const end = nl < 0 || nl > to ? to : nl
      out.push({ start: i, end })
      i = end
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 || close + 2 > to ? to : close + 2
      out.push({ start: i, end })
      i = end
    } else i++
  }
  return out
}

/**
 * The comment nodes of a tree, and the JS comments of its frontmatter, its script bodies and its
 * `{…}` expressions (`{/* … *\/}`), leaving out the markup an expression holds.
 */
function commentSpans(text: string, root: AstroNode, frontmatter: Span | null): Span[] {
  const out: Span[] = []
  const visit = (n: AstroNode): void => {
    if (n.type === 'comment') out.push({ start: n.start, end: n.end })
    if (n.type === 'element' && n.name === 'script') {
      const open = text.indexOf('>', n.start)
      if (open > 0 && open < n.end) out.push(...jsComments(text, open + 1, n.end))
    }
    if (n.type === 'expression') {
      const markup = n.children
      out.push(...jsComments(text, n.start, n.end).filter((c) => !markup.some((m) => c.start < m.end && c.end > m.start)))
    }
    n.children.forEach(visit)
  }
  visit(root)
  if (frontmatter) out.push(...jsComments(text, frontmatter.start, frontmatter.end))
  return out
}

/** The attribute with the whitespace before it, so cutting it leaves the tag as if it never had it. */
function withSpaceBefore(text: string, a: Span): Span {
  let start = a.start
  while (start > 0 && /\s/.test(text[start - 1]!)) start--
  return { start, end: a.end }
}

/** `<x>.integrity = '…'` or `<x>.crossOrigin = '…'` as whole lines (the value may sit on the next line). */
const propertyLine = (ident: string, prop: string): RegExp =>
  new RegExp(`^[ \\t]*${ident.replace(/\$/g, '\\$')}\\s*\\.\\s*${prop}\\s*=\\s*(?:\\r?\\n[ \\t]*)?(['"])[^'"\\n]*\\1[ \\t]*;?[ \\t]*(?:\\r?\\n|$)`, 'gm')

/** A root-relative src with `sentry` in it: a local copy of the bundle (`/js/sentry-8.55.0.min.js`). */
const isLocalSentry = (src: string): boolean => /^\/(?!\/)/.test(src.trim()) && /sentry/i.test(src)

/** `x.src = '<url>'` in a script body. */
const SRC_ASSIGN = /([\w$]+)\s*\.\s*src\s*=\s*(['"`])([^'"`\n]*)\2/g

interface FileResult {
  loaders: SentryLoader[]
  selfHosted: string[]
  reasons: string[]
  /** Hints to either host, to be judged once the whole site is read. */
  hints: SentryHint[]
}

/** The host of a URL (protocol-relative too), lower-cased; null when it is not an absolute URL. */
function hostOf(url: string): string | null {
  const u = url.trim()
  if (!/^(?:https?:)?\/\//i.test(u)) return null
  try {
    return new URL(u.startsWith('//') ? `https:${u}` : u).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return null
  }
}
const isSentryHost = (host: string): boolean => host === 'sentry-cdn.com' || host.endsWith('.sentry-cdn.com')
const HINT_RELS = /^(?:preconnect|dns-prefetch)$/

/** The element as whole lines when nothing else shares them, else with the whitespace before it. */
function elementCut(text: string, n: Span): Span {
  const start = text.lastIndexOf('\n', n.start - 1) + 1
  const nl = text.indexOf('\n', n.end)
  const end = nl < 0 ? text.length : nl + 1
  if (text.slice(start, n.start).trim() === '' && text.slice(n.end, end).trim() === '') return { start, end }
  return withSpaceBefore(text, n)
}

/**
 * Whether the init runs before an async or defer bundle: an inline script with `Sentry.init` that
 * neither waits for the window's load nor, for defer, DOMContentLoaded; the bundle has no onload.
 */
function initRunsFirst(text: string, script: AstroNode, scripts: AstroNode[]): boolean {
  const has = (name: string) => script.attributes.some((a) => a.kind !== 'spread' && a.name.toLowerCase() === name)
  const defer = has('defer')
  if (!(has('async') || defer) || has('onload')) return false
  const inits = scripts.filter((s) => s !== script && !s.attributes.some((a) => a.kind !== 'spread' && a.name.toLowerCase() === 'src')).map((s) => text.slice(s.start, s.end)).filter((b) => /Sentry\s*\.\s*init\b/.test(b))
  if (inits.length === 0) return false
  return inits.every((b) => !/addEventListener\s*\(\s*(['"`])load\1|\bonload\b/.test(b) && !(defer && /DOMContentLoaded/.test(b)))
}

function scanAstro(file: string, text: string): FileResult {
  const out: FileResult = { loaders: [], selfHosted: [], reasons: [], hints: [] }
  const mentions = [...text.matchAll(SENTRY_CDN_MENTION)].map((m) => m.index)
  let tree: ReturnType<typeof parseAstro>
  try {
    tree = parseAstro(text)
  } catch (e) {
    if (mentions.length) out.reasons.push(`${file} names a Sentry CDN and does not parse: ${(e as Error).message}`)
    return out
  }
  const ignored = commentSpans(text, tree.root, tree.frontmatter)
  const accounted: Span[] = []

  // Every element but <script>: a hint, or any other attribute that is a Sentry CDN URL.
  const visit = (n: AstroNode): void => {
    if (n.type === 'element' && n.name !== 'script') {
      const httpEquiv = n.attributes.find((a) => a.kind === 'quoted' && a.name.toLowerCase() === 'http-equiv')
      const isCsp = n.name === 'meta' && httpEquiv !== undefined && /content-security-policy/i.test(httpEquiv.value)
      const rel = n.attributes.find((a) => a.kind === 'quoted' && a.name.toLowerCase() === 'rel')?.value.trim().toLowerCase() ?? ''
      for (const a of n.attributes) {
        if (a.kind !== 'quoted' || isCsp) continue
        const host = hostOf(a.value)
        if (host === null) continue
        const at = text.indexOf(a.value, a.start)
        const line = lineOf(text, at)
        const sentry = isSentryHost(host)
        const jsdelivr = host === 'cdn.jsdelivr.net'
        if (n.name === 'link' && a.name.toLowerCase() === 'href' && HINT_RELS.test(rel) && (sentry || jsdelivr) && /^(?:(?:https?:)?\/\/[^/]+)\/?$/i.test(a.value.trim())) {
          out.hints.push({ file, line, host, rel, ...elementCut(text, n) })
          accounted.push({ start: at, end: at + a.value.length })
        } else if (sentry || sentryCdnOf(a.value.trim()) !== null) {
          out.reasons.push(`${file}:${line} <${n.name} ${a.name}="${a.value.trim()}">${rel ? ` (rel ${rel})` : ''} points at a Sentry CDN: not a load or a hint the tool can cut`)
          accounted.push({ start: at, end: at + a.value.length })
        }
      }
    }
    n.children.forEach(visit)
  }
  visit(tree.root)

  const scripts = elements(tree.root, 'script')
  for (const script of scripts) {
    const src = script.attributes.find((a): a is AstroAttribute => a.kind !== 'spread' && a.name.toLowerCase() === 'src')
    if (src) {
      if (src.kind === 'quoted' && isLocalSentry(src.value)) out.selfHosted.push(src.value.trim())
      if (src.kind !== 'quoted' || sentryCdnOf(src.value.trim()) === null) continue
      const at = text.indexOf(src.value, src.start)
      const line = lineOf(text, at)
      const judged = judgeBundleUrl(src.value)
      // One reason for it: its mention is accounted for here.
      if (!judged.ok) {
        out.reasons.push(`${file}:${line} ${judged.why}`)
        accounted.push({ start: at, end: at + src.value.length })
        continue
      }
      const cuts: SentryLoader['cuts'] = []
      let refused = false
      if (!script.attributes.some((a) => a.kind !== 'spread' && a.name === 'is:inline')) {
        out.reasons.push(`${file}:${line} the Sentry <script src> is without is:inline: Astro would process the local src the tool writes`)
        refused = true
      }
      for (const a of script.attributes) {
        if (a.kind === 'spread') continue
        const name = a.name.toLowerCase()
        if (name !== 'integrity' && name !== 'crossorigin') continue
        if (a.kind === 'expression') {
          out.reasons.push(`${file}:${lineOf(text, a.start)} the Sentry script's ${a.name} is an expression: the tool cuts only a literal one`)
          refused = true
        } else cuts.push({ ...withSpaceBefore(text, a), what: name })
      }
      accounted.push({ start: at, end: at + src.value.length })
      if (!refused) {
        const initBeforeBundle = initRunsFirst(text, script, scripts)
        out.loaders.push({ file, line, cdn: judged.cdn, version: judged.version, url: src.value, kind: 'element', src: { start: at, end: at + src.value.length }, cuts, initBeforeBundle })
      }
      continue
    }
    // An inline script that builds the element itself.
    const open = text.indexOf('>', script.start)
    const body = { start: open + 1, end: script.end }
    const bodyText = text.slice(body.start, body.end)
    for (const m of bodyText.matchAll(SRC_ASSIGN)) {
      const url = m[3]!
      if (isLocalSentry(url)) out.selfHosted.push(url.trim())
      if (sentryCdnOf(url) === null) continue
      const at = body.start + m.index + m[0].indexOf(url, m[0].indexOf('=') + 1)
      if (ignored.some((s) => at >= s.start && at < s.end)) continue
      const line = lineOf(text, at)
      accounted.push({ start: at, end: at + url.length })
      const judged = judgeBundleUrl(url)
      if (!judged.ok) {
        out.reasons.push(`${file}:${line} ${judged.why}`)
        continue
      }
      const ident = m[1]!
      const cuts: SentryLoader['cuts'] = []
      for (const [prop, what] of [
        ['integrity', 'integrity'],
        ['crossOrigin', 'crossorigin'],
      ] as const) {
        for (const p of bodyText.matchAll(propertyLine(ident, prop))) cuts.push({ start: body.start + p.index, end: body.start + p.index + p[0].length, what })
      }
      // An integrity set any other way (setAttribute, a variable) would no longer match the local copy.
      const left = cuts.reduceRight((t, c) => t.slice(0, c.start - body.start) + ' '.repeat(c.end - c.start) + t.slice(c.end - body.start), bodyText)
      if (/integrity/i.test(left)) {
        out.reasons.push(`${file}:${line} the script that adds the Sentry bundle sets its integrity in a way the tool does not cut`)
        continue
      }
      // The script adds the element and sets its onload: the init follows the bundle.
      out.loaders.push({ file, line, cdn: judged.cdn, version: judged.version, url, kind: 'script', src: { start: at, end: at + url.length }, cuts: cuts.sort((a, b) => a.start - b.start), initBeforeBundle: false })
    }
  }

  const inside = (at: number, spans: Span[]) => spans.some((s) => at >= s.start && at < s.end)
  for (const at of mentions) {
    if (inside(at, ignored) || inside(at, accounted)) continue
    out.reasons.push(unrecognised(file, text, at))
  }
  return out
}

/** The reason for a mention of a CDN that is not a load the tool can rewrite. */
function unrecognised(file: string, text: string, at: number): string {
  const what = /^[^\s"'`<>)]*/.exec(text.slice(at))![0].slice(0, 80)
  return `${file}:${lineOf(text, at)} names ${what}…, not as a <script src> or x.src = '…' the tool can rewrite`
}

/** A jsDelivr URL with a path other than Sentry's: the site loads something else from jsDelivr. */
const OTHER_JSDELIVR = /cdn\.jsdelivr\.net\/(?!npm\/@sentry\/)[^\s"'`<>)]/i

export function detectSentry(files: SiteFiles): SentryInfo {
  const loaders: SentryLoader[] = []
  const selfHosted: string[] = []
  const reasons: string[] = []
  const found: SentryHint[] = []
  let otherJsdelivr = false
  const paths = [...new Set([...files.list('src/**'), ...files.list('public/**'), ...files.list('astro.config.*')])].filter((f) => !BINARY.test(f)).sort()
  for (const file of paths) {
    const text = files.read(file)
    if (text.includes('\u0000') || SENTRY_BUNDLE_HEADER.test(text)) continue
    if (OTHER_JSDELIVR.test(text)) otherJsdelivr = true
    if (file.endsWith('.astro')) {
      const r = scanAstro(file, text)
      loaders.push(...r.loaders)
      found.push(...r.hints)
      for (const s of r.selfHosted) if (!selfHosted.includes(s)) selfHosted.push(s)
      for (const reason of r.reasons) if (!reasons.includes(reason)) reasons.push(reason)
      continue
    }
    for (const m of text.matchAll(SENTRY_CDN_MENTION)) {
      const reason = unrecognised(file, text, m.index)
      if (!reasons.includes(reason)) reasons.push(reason)
    }
  }
  if (loaders.length && selfHosted.length) reasons.push(`loads Sentry from a CDN and from ${selfHosted.join(', ')}`)
  // A jsDelivr hint is Sentry's only when nothing else comes from jsDelivr, and only beside a Sentry load.
  const sentryUse = loaders.length > 0 || selfHosted.length > 0
  const hints = found.filter((h) => isSentryHost(h.host) || (h.host === 'cdn.jsdelivr.net' && !otherJsdelivr && sentryUse))
  if (loaders.length === 0) for (const h of hints) reasons.push(`${h.file}:${h.line} ${h.rel} to ${h.host} with no Sentry CDN load beside it: remove it by hand`)
  const status = reasons.length ? 'needs-human' : loaders.length ? 'wire' : selfHosted.length ? 'self-hosted' : 'none'
  return { status, loaders, selfHosted, reasons, hints: status === 'wire' ? hints : [] }
}

/** HTML comments in plain markup (an .html file). */
const htmlComments = (text: string): Span[] => [...text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }))

/** Any name of a Sentry CDN host (bare origin included), or jsDelivr's Sentry path. */
const HOST_REFERENCE = /(?:[\w-]+\.)*sentry-cdn\.com|cdn\.jsdelivr\.net\/npm\/@sentry\//gi
/** A line that is a Content-Security-Policy (a header, a meta, a directive string): its host list is not a load. */
const CSP_LINE = /content-security-policy|\b(?:default|script|connect|img|style|font|frame|worker)-src(?:-elem|-attr)?\b/i

/**
 * Every place (outside comments and CSP lines) that still names a Sentry CDN host, bare origin
 * included, in the files detect reads: verify step 2 requires none once the bundle is self-hosted.
 * One line each: `<file>:<line> still names <host>: <the line, trimmed>`.
 */
export function sentryHostReferences(files: SiteFiles): string[] {
  const out: string[] = []
  const paths = [...new Set([...files.list('src/**'), ...files.list('public/**'), ...files.list('astro.config.*')])].filter((f) => !BINARY.test(f)).sort()
  for (const file of paths) {
    const text = files.read(file)
    if (text.includes('\u0000') || SENTRY_BUNDLE_HEADER.test(text)) continue
    const hits = [...text.matchAll(HOST_REFERENCE)]
    if (hits.length === 0) continue
    let comments: Span[] = []
    if (file.endsWith('.astro')) {
      try {
        const tree = parseAstro(text)
        comments = commentSpans(text, tree.root, tree.frontmatter)
      } catch {
        comments = []
      }
    } else if (/\.(?:[cm]?[jt]s|tsx?|jsx)$/.test(file)) comments = jsComments(text, 0, text.length)
    else if (/\.html?$/.test(file)) comments = htmlComments(text)
    for (const m of hits) {
      if (comments.some((c) => m.index >= c.start && m.index < c.end)) continue
      const start = text.lastIndexOf('\n', m.index - 1) + 1
      const nl = text.indexOf('\n', m.index)
      const line = text.slice(start, nl < 0 ? text.length : nl)
      if (CSP_LINE.test(line)) continue
      const entry = `${file}:${lineOf(text, m.index)} still names ${m[0].toLowerCase().replace(/\/npm\/@sentry\/$/, '/npm/@sentry/')}: ${line.trim().slice(0, 160)}`
      if (!out.includes(entry)) out.push(entry)
    }
  }
  return out
}
