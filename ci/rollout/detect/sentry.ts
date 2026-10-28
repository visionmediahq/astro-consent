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
// script, are not loads; a bare origin (a CSP's `https://browser.sentry-cdn.com`) is not a mention.
import { type AstroAttribute, type AstroNode, elements, parseAstro } from '../lib/astro-ast'
import { judgeBundleUrl, SENTRY_BUNDLE_HEADER, SENTRY_CDN_MENTION, sentryCdnOf } from '../lib/sentry'
import type { SiteFiles } from '../lib/site-files'
import type { SentryInfo, SentryLoader } from '../types'
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
}

function scanAstro(file: string, text: string): FileResult {
  const out: FileResult = { loaders: [], selfHosted: [], reasons: [] }
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

  for (const script of elements(tree.root, 'script')) {
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
      if (!refused) out.loaders.push({ file, line, cdn: judged.cdn, version: judged.version, url: src.value, kind: 'element', src: { start: at, end: at + src.value.length }, cuts })
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
      out.loaders.push({ file, line, cdn: judged.cdn, version: judged.version, url, kind: 'script', src: { start: at, end: at + url.length }, cuts: cuts.sort((a, b) => a.start - b.start) })
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

export function detectSentry(files: SiteFiles): SentryInfo {
  const loaders: SentryLoader[] = []
  const selfHosted: string[] = []
  const reasons: string[] = []
  const paths = [...new Set([...files.list('src/**'), ...files.list('public/**'), ...files.list('astro.config.*')])].filter((f) => !BINARY.test(f)).sort()
  for (const file of paths) {
    const text = files.read(file)
    if (text.includes('\u0000') || SENTRY_BUNDLE_HEADER.test(text)) continue
    if (file.endsWith('.astro')) {
      const r = scanAstro(file, text)
      loaders.push(...r.loaders)
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
  const status = reasons.length ? 'needs-human' : loaders.length ? 'wire' : selfHosted.length ? 'self-hosted' : 'none'
  return { status, loaders, selfHosted, reasons }
}
