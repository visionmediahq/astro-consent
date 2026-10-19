// Detects how a site loads Google Fonts, for self-hosting them (site-factory#220). Separate from
// the banner rollout: nothing here changes the site's classification.
//
// Misreading goes one way only. A `wire` the tool should not have given would leave a request to
// Google on the site, or break its fonts; a false `needs-human` costs a technician a look. So every
// mention of fonts.googleapis.com / fonts.gstatic.com in the files read must be accounted for by a
// recognised location or CSP, or be inside a comment; anything else is a reason. Recognised:
// `<link>` elements (stylesheet, preload as=style, preconnect/dns-prefetch) in .astro markup, a
// `<noscript>` holding only such links, a frontmatter `const` used only as their href, a CSS
// `@import`, and CSP strings (meta, `_headers`, a module's directive strings).
import { posix } from 'node:path'
import ts from 'typescript'
import type { FontCsp, FontLocation, FontsInfo } from '../types'
import { type AstroAttribute, type AstroNode, attr, parseAstro } from '../lib/astro-ast'
import { findDefineConfig, importsOf, parseModule, propertyOf } from '../lib/ts-ast'
import type { SiteFiles } from '../lib/site-files'
import { packageDeps } from './scripts'

const HOST = /fonts\.(?:googleapis|gstatic)\.com/gi
const ORIGINS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'])
/** Binary files; svg is text and read. */
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf|mp[34]|webm|ogg|wav|mov|zip|gz)$/i
const MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/
/** Attributes a recognised Google Fonts `<link>` may carry; wire removes the whole element. */
const LINK_ATTRS = new Set(['rel', 'href', 'as', 'media', 'onload', 'crossorigin', 'type', 'fetchpriority', 'referrerpolicy'])
/** A CSP directive string: `font-src 'self' …`, or a whole policy. */
const DIRECTIVE = /^\s*[a-z-]+-src\s|;\s*[a-z-]+-src\s/i
const IDENT = /^[A-Za-z_$][\w$]*$/

const hostsIn = (text: string): number[] => [...text.matchAll(HOST)].map((m) => m.index)
const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length
const decode = (s: string): string => s.replaceAll('&amp;', '&')

/** What is wrong with a Google Fonts stylesheet URL, or null for a css2 URL the tool can self-host. */
function urlProblem(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `url not understood: ${url}`
  }
  if (u.hostname !== 'fonts.googleapis.com' || u.protocol !== 'https:') return `url not understood: ${url}`
  if (u.pathname === '/css') return `css v1 API (fonts.googleapis.com/css?family=): ${url}`
  if (u.pathname === '/icon') return `icon font (Material Icons API): ${url}`
  if (u.pathname !== '/css2') return `url not understood: ${url}`
  if (u.searchParams.has('text')) return `text= subset: ${url}`
  const families = u.searchParams.getAll('family')
  if (families.length === 0) return `url not understood (no family): ${url}`
  if (families.some((f) => /^Material (?:Icons|Symbols)/i.test(f))) return `icon family: ${url}`
  return null
}

/** What in a policy would stop self-hosted fonts loading, or null. */
function cspProblem(policy: string): string | null {
  const dirs = new Map<string, string[]>()
  for (const d of policy.split(';')) {
    const [name, ...values] = d.trim().split(/\s+/)
    if (name && !dirs.has(name.toLowerCase())) dirs.set(name.toLowerCase(), values)
  }
  for (const d of ['font-src', 'style-src']) {
    const values = dirs.get(d) ?? dirs.get('default-src')
    if (values && !values.includes("'self'")) return `${d} (or default-src) lacks 'self'`
  }
  return null
}

interface Span {
  start: number
  end: number
}
const inside = (spans: Span[], at: number): boolean => spans.some((s) => s.start <= at && at < s.end)

/** The deepest node at `pos`, and whether `pos` is in its leading trivia (a comment, for a host name). */
function nodeAt(sf: ts.SourceFile, pos: number): { node: ts.Node; trivia: boolean } {
  let node: ts.Node = sf
  for (;;) {
    const next: ts.Node | undefined = ts.forEachChild(node, (c) => (c.pos <= pos && pos < c.end ? c : undefined))
    if (!next) break
    node = next
  }
  return { node, trivia: pos < node.getStart(sf) }
}

const isStringNode = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)

/** Every string literal (or template piece) node, in source order. */
function stringNodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (n: ts.Node): void => {
    if (isStringNode(n)) out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Comment spans of a CSS text (strings respected), and the text with comments blanked out. */
function cssComments(text: string): { spans: Span[]; blanked: string } {
  const spans: Span[] = []
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote || c === '\n') quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? text.length : close + 2
      spans.push({ start: i, end })
      i = end - 1
    }
  }
  let blanked = text
  for (const s of spans) blanked = blanked.slice(0, s.start) + ' '.repeat(s.end - s.start) + blanked.slice(s.end)
  return { spans, blanked }
}

const CSS_IMPORT = /@import\s+(?:url\(\s*(["']?)([^"')\s]*)\1\s*\)|(["'])([^"'\n]*)\3)([^;]*);/g

class Collector {
  locations: FontLocation[] = []
  csp: FontCsp[] = []
  urls: string[] = []
  reasons: string[] = []
  /** Stylesheet links with a dynamic href; reasons only when the site loads Google Fonts or the href says "font". */
  dynamic: { reason: string; fontish: boolean }[] = []
  /** Files with a stylesheet location, which must import the Tailwind entry. */
  stylesheetFiles = new Set<string>()
  selfHosted = false

  reason(r: string): void {
    if (!this.reasons.includes(r)) this.reasons.push(r)
  }

  url(file: string, raw: string): void {
    const url = decode(raw)
    if (!this.urls.includes(url)) this.urls.push(url)
    const problem = urlProblem(url)
    if (problem) this.reason(`${file}: ${problem}`)
  }

  policy(file: string, policy: string): void {
    const problem = cspProblem(policy)
    if (problem) this.reason(`${file}: Content-Security-Policy ${problem}`)
  }
}

function astroFile(files: SiteFiles, file: string, c: Collector): void {
  const text = files.read(file)
  if (text.includes('@font-face')) c.selfHosted = true
  const hosts = hostsIn(text)
  if (hosts.length === 0 && !/<link\b[^>]*\bhref=\{/.test(text)) return
  let tree: ReturnType<typeof parseAstro>
  try {
    tree = parseAstro(text)
  } catch (e) {
    if (hosts.length > 0) c.reason(`${file}: does not parse, so its Google Fonts references were not read (${e instanceof Error ? e.message : String(e)})`)
    return
  }
  const { frontmatter, root } = tree
  const sf = frontmatter ? parseModule(frontmatter.text) : null
  const fmOffset = frontmatter?.start ?? 0

  const accounted: Span[] = []
  const comments: Span[] = []
  /** const name -> its statement and the number of href uses found. */
  const consts = new Map<string, { span: Span; value: string; uses: number; ok: boolean }>()
  if (sf) {
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue
      const decls = stmt.declarationList.declarations
      for (const decl of decls) {
        const init = decl.initializer
        if (!ts.isIdentifier(decl.name) || !init || !(ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) continue
        if (hostsIn(init.text).length === 0) continue
        consts.set(decl.name.text, {
          span: { start: fmOffset + stmt.getStart(sf), end: fmOffset + stmt.end },
          value: init.text,
          uses: 0,
          ok: decls.length === 1 && !stmt.modifiers?.length,
        })
      }
    }
  }

  const hrefOf = (node: AstroNode): AstroAttribute | undefined => node.attributes.find((a) => a.kind !== 'spread' && a.name === 'href')

  /** The Google Fonts URL a link's href holds (literal or const), or null when it holds none. */
  const fontHref = (node: AstroNode): { url: string; via: string | null } | null => {
    const href = hrefOf(node)
    if (!href) return null
    if (href.kind === 'quoted') return hostsIn(href.value).length > 0 ? { url: href.value, via: null } : null
    if (href.kind === 'expression' && IDENT.test(href.value.trim())) {
      const k = consts.get(href.value.trim())
      if (k) return { url: k.value, via: href.value.trim() }
    }
    return null
  }

  const relOf = (node: AstroNode): string[] => {
    const rel = attr(node, 'rel')
    return rel?.kind === 'quoted' ? rel.value.toLowerCase().split(/\s+/).filter(Boolean) : []
  }

  /** Checks a Google Fonts link and returns its kind, or null after a reason. */
  const fontLink = (node: AstroNode, gf: { url: string; via: string | null }, inExpression: boolean): FontLocation['kind'] | null => {
    if (inExpression) {
      c.reason(`${file}:${lineOf(text, node.start)}: Google Fonts <link> inside an expression`)
      return null
    }
    let ok = true
    for (const a of node.attributes) {
      if (a.kind === 'spread' || !LINK_ATTRS.has(a.name) || (a.kind === 'expression' && !(a.name === 'href' && gf.via))) {
        c.reason(`${file}:${lineOf(text, node.start)}: attribute ${a.kind === 'spread' ? `{...${a.value}}` : a.name} on a Google Fonts <link> not understood`)
        ok = false
      }
    }
    if (gf.via) consts.get(gf.via)!.uses++
    const rel = relOf(node)
    const as = attr(node, 'as')
    let kind: FontLocation['kind'] | null = null
    if (rel.length > 0 && rel.every((r) => r === 'preconnect' || r === 'dns-prefetch')) {
      if (!ORIGINS.has(decode(gf.url).replace(/\/$/, ''))) c.reason(`${file}:${lineOf(text, node.start)}: <link rel="${rel.join(' ')}"> to ${gf.url} not understood`)
      else kind = 'preconnect'
    } else if (rel.length === 1 && rel[0] === 'stylesheet') kind = 'link'
    else if (rel.length === 1 && rel[0] === 'preload' && as?.kind === 'quoted' && as.value === 'style') kind = 'preload'
    else c.reason(`${file}:${lineOf(text, node.start)}: <link rel="${rel.join(' ')}"${as ? ` as="${as.value}"` : ''}> to Google Fonts not understood`)
    if (kind === 'link' || kind === 'preload') {
      c.url(file, gf.url)
      c.stylesheetFiles.add(file)
    }
    return ok ? kind : null
  }

  const dynamicHref = (node: AstroNode): void => {
    const href = hrefOf(node)
    if (href?.kind !== 'expression') return
    const rel = relOf(node)
    const as = attr(node, 'as')
    const stylePreload = rel.includes('preload') && !(as?.kind === 'quoted' && as.value.toLowerCase() !== 'style')
    if (!rel.includes('stylesheet') && !stylePreload) return
    const value = href.value.trim()
    if (IDENT.test(value) && sf) {
      const decl = sf.statements.find(
        (s): s is ts.VariableStatement => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === value),
      )
      const init = decl?.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === value)?.initializer
      if (decl && decl.declarationList.flags & ts.NodeFlags.Const && init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) return
    }
    c.dynamic.push({ reason: `${file}:${lineOf(text, node.start)}: stylesheet <link> with a dynamic href {${value}}`, fontish: /font/i.test(value) })
  }

  const visit = (node: AstroNode, inExpression: boolean): void => {
    if (node.type === 'comment') {
      comments.push(node)
      return
    }
    if (node.type === 'element' && node.name === 'link') {
      const gf = fontHref(node)
      if (!gf) {
        dynamicHref(node)
        return
      }
      accounted.push(node)
      const kind = fontLink(node, gf, inExpression)
      if (kind) c.locations.push({ file, kind, start: node.start, end: node.end })
      return
    }
    if (node.type === 'element' && node.name === 'meta') {
      const equiv = attr(node, 'http-equiv')
      if (equiv?.kind === 'quoted' && equiv.value.toLowerCase() === 'content-security-policy') {
        const content = attr(node, 'content')
        if (content?.kind === 'quoted' && hostsIn(content.value).length > 0) {
          accounted.push(node)
          c.csp.push({ file, kind: 'meta', start: node.start, end: node.end })
          c.policy(file, decode(content.value))
        }
        return
      }
    }
    if (node.type === 'element' && node.name === 'noscript') {
      const links = node.children.filter((n) => n.type === 'element' && n.name === 'link' && fontHref(n))
      if (links.length > 0) {
        accounted.push(node)
        const rest = node.children.filter((n) => !links.includes(n) && !(n.type === 'text' && text.slice(n.start, n.end).trim() === ''))
        if (rest.length > 0 || inExpression) {
          c.reason(`${file}:${lineOf(text, node.start)}: <noscript> holds more than Google Fonts stylesheet links${inExpression ? ', inside an expression' : ''}`)
          return
        }
        let ok = true
        for (const link of links) {
          const kind = fontLink(link, fontHref(link)!, false)
          if (kind !== 'link') {
            if (kind) c.reason(`${file}:${lineOf(text, link.start)}: <noscript> holds a Google Fonts <link> that is not a stylesheet`)
            ok = false
          }
        }
        if (ok) c.locations.push({ file, kind: 'noscript', start: node.start, end: node.end })
        return
      }
    }
    for (const child of node.children) visit(child, inExpression || node.type === 'expression')
  }
  visit(root, false)

  // A const used as href is accounted for only when nothing else uses it.
  const template = frontmatter ? text.slice(frontmatter.end + 3) : text
  for (const [name, k] of consts) {
    if (k.uses === 0) continue
    const inFrontmatter = sf ? countIdentifiers(sf, name) - 1 : 0
    const inTemplate = [...template.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))].length
    accounted.push(k.span)
    if (!k.ok || inFrontmatter !== 0 || inTemplate !== k.uses) {
      c.reason(`${file}: const ${name} holds a Google Fonts url and is used for more than a <link> href`)
      continue
    }
    c.locations.push({ file, kind: 'const', ...k.span })
  }

  for (const at of hosts) {
    if (inside(accounted, at) || inside(comments, at)) continue
    if (frontmatter && sf && at >= frontmatter.start && at < frontmatter.end && nodeAt(sf, at - fmOffset).trivia) continue
    const inExpressionAttr = hrefExpressionAt(root, at)
    c.reason(
      inExpressionAttr
        ? `${file}:${lineOf(text, at)}: Google Fonts url in an expression`
        : `${file}:${lineOf(text, at)}: Google Fonts host outside a recognised <link>, @import or CSP`,
    )
  }
}

function countIdentifiers(sf: ts.SourceFile, name: string): number {
  let n = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) n++
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

/** Whether `at` lies in an expression-valued attribute anywhere in the tree. */
function hrefExpressionAt(root: AstroNode, at: number): boolean {
  const visit = (n: AstroNode): boolean =>
    n.attributes.some((a) => a.kind === 'expression' && a.start <= at && at < a.end) || n.children.some(visit)
  return visit(root)
}

function cssFile(files: SiteFiles, file: string, c: Collector): void {
  const text = files.read(file)
  const { spans, blanked } = cssComments(text)
  if (blanked.includes('@font-face')) c.selfHosted = true
  const hosts = hostsIn(text)
  if (hosts.length === 0) return
  const accounted: Span[] = []
  for (const m of blanked.matchAll(CSS_IMPORT)) {
    const url = m[2] ?? m[4] ?? ''
    if (hostsIn(url).length === 0) continue
    const span = { start: m.index, end: m.index + m[0].length }
    accounted.push(span)
    if (m[5]!.trim() !== '') {
      c.reason(`${file}:${lineOf(text, m.index)}: @import of Google Fonts with "${m[5]!.trim()}" not understood`)
      continue
    }
    c.url(file, url)
    c.locations.push({ file, kind: 'import', ...span })
  }
  for (const at of hosts) {
    if (inside(accounted, at) || inside(spans, at)) continue
    c.reason(`${file}:${lineOf(text, at)}: Google Fonts host outside a recognised <link>, @import or CSP`)
  }
}

function moduleFile(files: SiteFiles, file: string, c: Collector): void {
  const text = files.read(file)
  const hosts = hostsIn(text)
  if (hosts.length === 0) return
  const sf = parseModule(text)
  let csp = false
  for (const at of hosts) {
    const { node, trivia } = nodeAt(sf, at)
    if (trivia) continue
    if (isStringNode(node) && DIRECTIVE.test(node.text)) {
      csp = true
      const span = { start: node.getStart(sf), end: node.end }
      if (!c.csp.some((x) => x.file === file && x.start === span.start)) c.csp.push({ file, kind: 'module', ...span })
      continue
    }
    c.reason(`${file}:${lineOf(text, at)}: Google Fonts host outside a recognised <link>, @import or CSP`)
  }
  if (csp) {
    c.policy(
      file,
      stringNodes(sf)
        .map((n) => (n as ts.LiteralLikeNode).text)
        .filter((s) => DIRECTIVE.test(s))
        .join('; '),
    )
  }
}

function headersFile(files: SiteFiles, file: string, c: Collector): void {
  const text = files.read(file)
  let offset = 0
  for (const line of text.split('\n')) {
    const start = offset
    offset += line.length + 1
    if (hostsIn(line).length === 0 || line.trimStart().startsWith('#')) continue
    const m = /^\s*Content-Security-Policy\s*:(.*)$/i.exec(line)
    if (!m) {
      c.reason(`${file}:${lineOf(text, start)}: Google Fonts host outside a recognised <link>, @import or CSP`)
      continue
    }
    c.csp.push({ file, kind: 'headers', start, end: start + line.replace(/\r$/, '').length })
    c.policy(file, m[1]!)
  }
}

/** Whether `file` (an .astro file) imports the CSS entry `entry` in its frontmatter. */
function importsEntry(files: SiteFiles, file: string, entry: string): boolean {
  const fm = parseAstro(files.read(file)).frontmatter
  if (!fm) return false
  return importsOf(parseModule(fm.text)).some((i) => i.from.startsWith('.') && posix.normalize(posix.join(posix.dirname(file), i.from)) === entry)
}

function astroFontsConfig(files: SiteFiles): string | null {
  const config = files.list('astro.config.*')[0]
  if (!config) return null
  const text = files.read(config)
  const obj = findDefineConfig(parseModule(text))
  if (obj) return propertyOf(obj, 'fonts') ? config : null
  return /\bfonts\s*:\s*\[/.test(text) ? config : null
}

/**
 * How the site loads Google Fonts. `cssEntry` is the Tailwind CSS entry (`report.css.entry`), where
 * wire imports the self-hosted faces.
 */
export function detectFonts(files: SiteFiles, cssEntry: string | null): FontsInfo {
  const c = new Collector()
  const textFiles = [...new Set([...files.list('src/**'), ...files.list('public/**')])].filter((f) => !BINARY.test(f))
  const rootFiles = files.list('*').filter((f) => MODULE.test(f) || f === '_headers' || /^\.env(?:\..+)?$/.test(f))
  for (const file of [...rootFiles, ...textFiles].sort()) {
    if (file.endsWith('.astro')) astroFile(files, file, c)
    else if (file.endsWith('.css') && file.startsWith('src/')) cssFile(files, file, c)
    else if (MODULE.test(file) && !file.startsWith('public/')) moduleFile(files, file, c)
    else if (file === '_headers' || file === 'public/_headers') headersFile(files, file, c)
    else {
      const text = files.read(file)
      if (text.includes('\u0000')) continue
      const at = hostsIn(text)[0]
      if (at !== undefined) c.reason(`${file}:${lineOf(text, at)}: Google Fonts host mentioned`)
    }
  }
  for (const d of c.dynamic) if (d.fontish || c.locations.length > 0 || c.reasons.length > 0) c.reason(d.reason)

  const byPlace = (a: { file: string; start: number }, b: { file: string; start: number }): number =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start
  const locations = c.locations.sort(byPlace)
  const csp = c.csp.sort(byPlace)
  const fontsConfig = astroFontsConfig(files)
  const fontFiles = files.list('{src,public}/**/*.{woff,woff2,ttf,otf,eot}').length > 0
  const fontsource = packageDeps(files).some((d) => /^@fontsource(?:-variable)?\//.test(d))

  if (locations.length === 0 && c.reasons.length === 0) {
    const selfHosted = c.selfHosted || fontFiles || fontsource || fontsConfig !== null
    return { status: selfHosted ? 'self-hosted' : 'none', url: null, urls: [], locations: [], csp, reasons: [] }
  }

  if (c.urls.length > 1) c.reason(`${c.urls.length} distinct Google Fonts urls: ${c.urls.join(' ')}`)
  if (c.urls.length === 0 && c.reasons.length === 0) c.reason('preconnect to Google Fonts without a stylesheet')
  if (fontsConfig) c.reason(`${fontsConfig}: the Astro fonts config is already set`)
  if (files.exists('src/styles/fonts.css')) c.reason('src/styles/fonts.css already exists')
  if (files.list('public/fonts/**').length > 0) c.reason('public/fonts/ already exists')
  if (cssEntry === null) c.reason('no Tailwind CSS entry to import the self-hosted fonts from')
  else {
    for (const file of [...c.stylesheetFiles].sort()) {
      if (!importsEntry(files, file, cssEntry)) c.reason(`${file} does not import ${cssEntry}`)
    }
  }
  const wire = c.reasons.length === 0
  return { status: wire ? 'wire' : 'needs-human', url: wire ? c.urls[0]! : null, urls: c.urls, locations, csp, reasons: c.reasons }
}
