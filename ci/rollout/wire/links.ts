// Wires <PrivacyLinks /> into every client footer and every footerless page.
//
// Footer (Rulings 17, 23, 29): from <footer>, descend through elements with exactly one element child
// (decoration not counted, phrasing/interactive elements never entered) to the first element with
// more than one, or to the deepest single-child wrapper: the slot.
//
// The © bottom bar (#47): when a child of the slot holds the copyright line (`©`, `&copy;`,
// "Copyright" before a year or an expression, "Alla rättigheter"), the links go into that bar: the
// last such child, descending into whichever child holds the line until the element that holds it
// directly, and the links follow that element as its sibling, in its row. A link in that row to
// the policy page that PrivacyLinks will render itself (policy_url) is replaced by the links; so is
// the only such link deeper in the bar, unless it sits in phrasing content (#61). "Only" counts
// every link to that page in the bar: in the © line, inside `{…}` and as a component (#65); wire
// replaces none when there are two. When the © element is a `<p>`/`<span>`/`<small>` with layout
// classes (a container, padding, a max width: site 1369745148), a `<div>` takes its classes and holds it and
// the links, so they stay inside the box (#65). With no © bar, the links are the slot's last
// child, as before.
//
// The colour class: the footer's own text colour class. With none, the nearest background from
// where the links go up to the <footer> decides (its inline style, its scoped CSS rule, a Tailwind
// or daisyUI bg-* class): dark → `text-white/70`, daisyUI bg-neutral/primary/… → its
// `text-*-content`, light or unknown → nothing, and verify's contrast step decides. With no
// background anywhere, a light text colour on the footer means a dark footer. A background wire
// cannot read (a CSS variable, a mid shade) is dark when white text sits on it elsewhere (#61).
//
// Alignment: in a flex or grid row of the © bar, nothing (the row places the links). In a block
// row the links sit on their own line under ©: `mt-2`, and the justify-* that matches the row's
// text alignment (`justify-start!` unless it is centred; responsive text-* get md:justify-*!).
// With no © bar, `justify-start!` when the footer's end is left-aligned or split (Rulings 18, 27:
// alignment === 'left' only).
//
// Footerless page (Rulings 11, 16, 26: detect's `footerless` already leaves out pages a footer
// reaches and CMS admin pages): the last child of <main>'s only element child, or of <main>; with
// no <main>, of the outermost template element (<body> when that is <html>). Class `mt-6`, so the
// links do not touch the button above them (#47).
import { type AstroNode, attr, elements } from '../lib/astro-ast'
import { type Rgb, wcagContrast } from '../lib/colour'
import type { FooterInfo, Report } from '../types'
import { type CssDecl, type CssRule, cssRules, declarations, ownRules, scopedStyles } from './embeds'
import { eolOf, type Hit, type Planner } from './engine'
import { childElements, indentAt, lastChildOf, parseFile, spliceTarget, startsLine, usesOf, wireImport } from './markup'
import { PRIVACY_JSON } from './privacy'

const classesOf = (n: AstroNode): string[] => {
  const cls = attr(n, 'class')
  return cls?.kind === 'quoted' ? cls.value.split(/\s+/).filter(Boolean) : []
}

/** Ruling 23: a child that only decorates its parent does not count when descending. */
function isDecoration(n: AstroNode): boolean {
  if (n.type !== 'element') return false
  if (attr(n, 'aria-hidden')?.value === 'true') return true
  if (classesOf(n).some((c) => c === 'absolute' || c === 'fixed' || c === 'pointer-events-none')) return true
  if (n.name === 'img') return attr(n, 'alt')?.value === ''
  if (n.name === 'svg') return attr(n, 'aria-label') === null && attr(n, 'aria-labelledby') === null && attr(n, 'role')?.value !== 'img'
  return false
}

/** Ruling 29: phrasing or interactive content never takes the links (a <nav> inside <p>, <a> or <h1> is invalid). */
const PHRASING = new Set(['p', 'a', 'span', 'button', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'small', 'b', 'i'])

/** An element the descent may enter: not phrasing or interactive content. */
const enterable = (n: AstroNode): boolean => n.type === 'element' && !PHRASING.has(n.name ?? '')

const contentChildren = (n: AstroNode): AstroNode[] => childElements(n).filter((c) => !isDecoration(c))

/** Where the links go in a footer with no © bar (Rulings 17, 23). */
export function footerSlot(footer: AstroNode): AstroNode {
  let node = footer
  for (;;) {
    const kids = contentChildren(node)
    const only = kids.length === 1 ? kids[0]! : null
    if (!only || !enterable(only) || contentChildren(only).length === 0) return node
    node = only
  }
}

// ── The © bottom bar (#47) ──

/**
 * A copyright line: ©, &copy;, "Alla rättigheter", or "Copyright" followed by a year, ©, (c) or
 * the end of the text node (a `{year}` expression follows). "Copyright och villkor" is a heading.
 */
const COPYRIGHT = /©|&copy;|&#169;|&#xa9;|alla rättigheter|\bcopyright\b(?=\s*(?:©|&copy;|\(c\)|\d{4}|$))/i

/** The text written directly in `n`, not in its child elements. */
const ownText = (text: string, n: AstroNode): string =>
  n.children
    .filter((c) => c.type === 'text')
    .map((c) => text.slice(c.start, c.end))
    .join('')

/** One of `n`'s own text nodes is a copyright line. */
const ownCopyright = (text: string, n: AstroNode): boolean =>
  n.children.some((c) => c.type === 'text' && COPYRIGHT.test(text.slice(c.start, c.end).trim()))

/** `n` or anything rendered inside it holds the copyright line. */
function holdsCopyright(text: string, n: AstroNode): boolean {
  if (n.type === 'text') return COPYRIGHT.test(text.slice(n.start, n.end).trim())
  if (n.type === 'comment' || (n.type === 'element' && (n.name === 'script' || n.name === 'style'))) return false
  return n.children.some((c) => holdsCopyright(text, c))
}

export interface BottomBar {
  /** The element whose child `mark` is: the links go into it. */
  row: AstroNode
  /** The child of `row` that holds the copyright line: the links follow it. */
  mark: AstroNode
}

/**
 * The © line under `slot`: the last content child that holds it, descended into while the line is
 * further down (never into phrasing content), until the element that holds it directly. Null when
 * no child of `slot` holds it.
 */
export function bottomBar(text: string, slot: AstroNode): BottomBar | null {
  let row = slot
  for (;;) {
    const mark = contentChildren(row).findLast((k) => holdsCopyright(text, k))
    if (!mark) return null
    const deeper = enterable(mark) && !ownCopyright(text, mark) && contentChildren(mark).some((k) => holdsCopyright(text, k))
    if (!deeper) return { row, mark }
    row = mark
  }
}

/** A path for comparing links: no query or fragment, no trailing slash. Null for other hosts or a relative href. */
function pathOf(href: string, domains: readonly string[]): string | null {
  const bare = (h: string): string => h.toLowerCase().replace(/^www\./, '')
  let path: string
  if (/^https?:\/\//i.test(href)) {
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return null
    }
    if (!domains.some((d) => bare(d) === bare(url.hostname))) return null
    path = url.pathname
  } else if (href.startsWith('/') && !href.startsWith('//')) {
    path = href.replace(/[?#].*$/, '')
  } else return null
  return path.replace(/\/+$/, '') || '/'
}

/**
 * The path of the policy page PrivacyLinks will link to: an existing privacy.json's policy_url, or
 * else the one wirePrivacy writes (report.policyPage). Null when it will not render one.
 */
function policyPath(planner: Planner, report: Pick<Report, 'policyPage' | 'domains'>): string | null {
  if (planner.files.exists(PRIVACY_JSON)) {
    try {
      const url = (JSON.parse(planner.files.read(PRIVACY_JSON)) as { policy_url?: unknown } | null)?.policy_url
      if (typeof url !== 'string') return null
      return pathOf(url, [new URL(url).hostname])
    } catch {
      return null
    }
  }
  return report.policyPage === null ? null : pathOf(report.policyPage, report.domains)
}

/** `n` is a link to `path`, alone or inside wrappers that hold nothing else. */
function isLinkTo(text: string, n: AstroNode, path: string, domains: readonly string[]): boolean {
  for (;;) {
    if (n.type !== 'element') return false
    if (n.name === 'a') return hrefPath(n, domains) === path
    const kids = contentChildren(n)
    if (kids.length !== 1 || ownText(text, n).trim() !== '') return false
    n = kids[0]!
  }
}

/**
 * The path an `<a>` links to: a quoted href, or an expression that is a string literal or a call
 * whose first argument is one (site 1369693991: `href={localize('/gdpr/', lang)}`). Null otherwise.
 */
function hrefPath(n: AstroNode, domains: readonly string[]): string | null {
  const href = attr(n, 'href')
  if (href?.kind === 'quoted') return pathOf(href.value, domains)
  if (href?.kind !== 'expression') return null
  const m =
    /^\s*(['"`])([^'"`$]*)\1\s*$/.exec(href.value) ?? /^\s*[\w$.]+\(\s*(['"`])([^'"`$]*)\1\s*(?:,\s*[\w$.]+\s*)*\)\s*$/.exec(href.value)
  return m ? pathOf(m[2]!, domains) : null
}

/** A policy link in the bar, with its parent and whether wire may replace it. */
interface Found {
  link: AstroNode
  parent: AstroNode
  ok: boolean
}

/**
 * Every link to `path` in `row`: `<a>` elements and components with that href (`<Link href>`),
 * including those inside the © element `mark` and inside `{…}` expressions (`{show && <a …>}`).
 * Only a plain `<a>` reached through shown flow containers, outside `mark`, outside expressions
 * and outside components, is `ok` (re-review of #63, #65: fail closed): wire never replaces a link
 * that renders only sometimes, one whose markup is elsewhere, or one in the © line.
 */
function policyLinks(row: AstroNode, mark: AstroNode, path: string, domains: readonly string[], rules: CssRule[]): Found[] {
  const found: Found[] = []
  const visit = (n: AstroNode, parent: AstroNode, ok: boolean): void => {
    if (n.type === 'element' && (n.name === 'script' || n.name === 'style')) return
    if (n.type !== 'element' && n.type !== 'component' && n.type !== 'expression' && n.type !== 'fragment') return
    const inside = ok && n !== mark
    if ((n.type === 'element' && n.name === 'a') || n.type === 'component') {
      if (hrefPath(n, domains) === path) {
        found.push({ link: n, parent, ok: inside && n.type === 'element' })
        return
      }
      if (n.type === 'element') return
    }
    const next = inside && n.type === 'element' && passes(n, rules)
    for (const c of n.children) visit(c, n, next)
  }
  for (const c of row.children) visit(c, row, passes(row, rules))
  return found
}

/**
 * The bar's own link to `path` below the © row's siblings (#61: site 1250154895's in a neighbouring
 * div, site 1369693991's in a `<ul>`), when it is the only link to `path` anywhere in `row` (#65: the ©
 * line, conditionals and components counted), its parent is a flow container that may hold a
 * <nav>, and nothing between the row and it is phrasing, hidden or decoration (Ruling 29; fail
 * closed). With its parent, for the layout.
 */
function deepPolicyLink(found: Found[], rules: CssRule[]): Found | null {
  const only = found.length === 1 ? found[0]! : null
  return only?.ok && holdsNav(only.parent, rules) ? only : null
}

/** Flow containers a <nav> may sit in. Anything else (phrasing, <pre>, <svg>, <address>, <dt>, a closed <details>…) is refused. */
const NAV_PARENTS = new Set(['div', 'li', 'dd', 'td', 'section', 'article', 'aside', 'nav', 'footer', 'header', 'main', 'figure', 'figcaption', 'form', 'fieldset', 'blockquote'])

/** Declarations that hide an element (#65): display none, visibility hidden, opacity 0. */
const hides = (d: CssDecl): boolean => {
  const v = d.value.replace(/!\s*important\s*$/i, '').trim().toLowerCase()
  return (d.prop === 'display' && v === 'none') || (d.prop === 'visibility' && v === 'hidden') || (d.prop === 'opacity' && /^0*(?:\.0*)?%?$/.test(v))
}

/**
 * Hidden from everyone, or on some screens, or from assistive technology: `hidden`, sr-only,
 * invisible, opacity-0 (any variant), an inline or scoped (`@media` too) rule that hides it, or a
 * class wire cannot read (`class:list`, `class={…}`), which may hide it (#65).
 */
const hiddenEl = (n: AstroNode, rules: CssRule[]): boolean =>
  isDecoration(n) ||
  attr(n, 'hidden') !== null ||
  n.attributes.some((a) => a.name === 'class:list' || (a.name === 'class' && a.kind !== 'quoted')) ||
  classesOf(n).some((c) => /^(?:sr-only|invisible)$/.test(c) || /(?:^|:)(?:hidden|opacity-0)$/.test(c)) ||
  ownDecls(n, rules).some(hides)

const holdsNav = (n: AstroNode, rules: CssRule[]): boolean => n.type === 'element' && NAV_PARENTS.has(n.name ?? '') && !hiddenEl(n, rules)

/** An ancestor the search may pass through: a flow container, or a list or table around one. */
const passes = (n: AstroNode, rules: CssRule[]): boolean =>
  n.type === 'element' && (NAV_PARENTS.has(n.name ?? '') || /^(?:ul|ol|dl|menu|table|thead|tbody|tfoot|tr)$/.test(n.name ?? '')) && !hiddenEl(n, rules)

/** `markup` right after `node`: on its own line at the node's indent when the node ends its line, inline otherwise. */
function afterNode(text: string, node: AstroNode, markup: string): { hit: Hit; text: string } {
  const hit = { start: node.end, end: node.end }
  const endsLine = /^[ \t]*(?:\r?\n|$)/.test(text.slice(node.end))
  return { hit, text: startsLine(text, node.start) && endsLine ? `${eolOf(text)}${indentAt(text, node.start)}${markup}` : markup }
}

// ── Colours and alignment, as far as the markup shows ──

const PALETTE = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'
const DARK_SHADE = new RegExp(`^bg-${PALETTE}-(?:900|950)$`)
const LIGHT_SHADE = new RegExp(`^bg-${PALETTE}-(?:50|100|200)$`)
const OTHER_SHADE = new RegExp(`^bg-${PALETTE}-\\d+$`)
/** daisyUI 5 colour backgrounds and the text class that goes on them. */
const DAISY_CONTENT = /^bg-(neutral|primary|secondary|accent|info|success|warning|error)$/
const DAISY_BASE = /^bg-base-(?:100|200|300)$/

/** A literal CSS colour with its alpha, or null (a variable without a fallback, a gradient, a keyword). */
function cssColour(value: string): (Rgb & { a: number }) | null {
  const v = value.replace(/!\s*important\s*$/i, '').trim().toLowerCase()
  const fallback = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/.exec(v)
  if (fallback) return cssColour(fallback[1]!)
  if (v.includes('gradient') || v.includes('var(')) return null
  let m = /(?:^|\s)#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?=\s|$)/.exec(v)
  if (m) {
    const h = m[1]!.length <= 4 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a }
  }
  m = /(?:^|\s)rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/.exec(v)
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha }
  }
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  return null
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/** text-white/70 composited on `bg` reads at 4.5:1 or better (what verify step 6 asks). */
function white70Readable(bg: Rgb): boolean {
  const mix = (c: number): number => 0.7 * 255 + 0.3 * c
  return wcagContrast({ r: mix(bg.r), g: mix(bg.g), b: mix(bg.b) }, bg) >= 4.5
}

/** The file's scoped rules, at-rules included (#65: a rule that hides on some screens hides). */
const allRules = (text: string, root: AstroNode): CssRule[] => scopedStyles(text, root).flatMap((s) => cssRules(text.slice(s.start, s.end), s.start))

/** The file's scoped rules outside at-rules (an `@media` rule applies on some screens only). */
const baseRules = (text: string, root: AstroNode): CssRule[] => allRules(text, root).filter((r) => !r.media)

/** The declarations that style `el` itself: its scoped rules (and `footer {…}` for a footer), then its inline style. */
function ownDecls(el: AstroNode, rules: CssRule[]): CssDecl[] {
  const own = rules.filter((r) => ownRules(el, [r]).length > 0 || (el.name === 'footer' && r.selector.split(',').some((s) => s.trim() === 'footer')))
  const style = attr(el, 'style')
  return [...own.flatMap((r) => r.decls), ...(style?.kind === 'quoted' ? declarations(style.value) : [])]
}

const lastValue = (decls: CssDecl[], props: string[]): string | undefined => decls.findLast((d) => props.includes(d.prop))?.value

/** A light text colour set on `el`: the designer put light text on a dark background. */
function lightText(decls: CssDecl[]): boolean {
  const v = lastValue(decls, ['color'])
  const fg = v === undefined ? null : cssColour(v)
  return fg !== null && wcagContrast(fg, BLACK) > wcagContrast(fg, WHITE)
}

/**
 * The text class `el`'s background calls for: a class or null (decided), or undefined when `el`
 * sets no background. A literal opaque CSS background decides first (dark → text-white/70, light
 * → null), then a Tailwind/daisyUI bg-* class without a variant; a background nobody can read
 * here (a variable, a mid shade) decides null unless `el` also sets a light text colour.
 */
function surfaceClass(el: AstroNode, rules: CssRule[]): string | null | undefined | typeof UNKNOWN {
  const decls = ownDecls(el, rules)
  const css = lastValue(decls, ['background', 'background-color'])
  let unknown = false
  if (css !== undefined) {
    const bg = cssColour(css)
    if (bg && bg.a === 1) return white70Readable(bg) ? 'text-white/70' : null
    unknown = true
  }
  for (const c of classesOf(el)) {
    if (c === 'bg-black' || DARK_SHADE.test(c)) return 'text-white/70'
    if (c === 'bg-white' || LIGHT_SHADE.test(c) || DAISY_BASE.test(c)) return null
    const daisy = DAISY_CONTENT.exec(c)
    if (daisy) return `text-${daisy[1]}-content`
    const arbitrary = /^bg-\[(#[0-9a-fA-F]{3,8})\]$/.exec(c)
    const bg = arbitrary ? cssColour(arbitrary[1]!) : null
    if (bg && bg.a === 1) return white70Readable(bg) ? 'text-white/70' : null
    if (arbitrary || OTHER_SHADE.test(c)) unknown = true
  }
  if (!unknown) return undefined
  return lightText(decls) ? 'text-white/70' : UNKNOWN
}

/** A background set but unreadable here (a variable, a mid shade): decided by the text around it (#61). */
const UNKNOWN = Symbol('unknown background')

/** `el` sets a background of its own: a bg-* class (no variant) or a background in its CSS. */
const ownBackground = (el: AstroNode, rules: CssRule[]): boolean =>
  classesOf(el).some((c) => /^(?:[\w-]+:)*bg-(?!opacity)/.test(c) || DAISY_SURFACE.test(c)) ||
  lastValue(ownDecls(el, rules), ['background', 'background-color', 'background-image']) !== undefined

/** daisyUI components that paint their own background (`btn-primary`, `badge`, …), so their white text says nothing. */
const DAISY_SURFACE = /^(?:btn|badge|alert|card|kbd|toast|tooltip|modal-box|dropdown-content|menu|hero-overlay|stat|tab-active|mockup-[\w-]+)(?:-[\w-]+)?$/

/**
 * White text on `surface` itself (#61: site 1253341044 `text-white/45`, site 1244371378 inline
 * `rgba(255,255,255,0.4)`, site 1243539503 `text-white` headings): a `text-white` or `text-white/NN` class
 * without a variant, or a light inline/scoped colour, on an element under `surface` that is not
 * inside another background (a button's white text says nothing about the footer).
 */
function whiteTextOn(surface: AstroNode, rules: CssRule[]): boolean {
  const visit = (n: AstroNode): boolean => {
    if (n.type !== 'element' || n.name === 'script' || n.name === 'style') return false
    if (n !== surface && (ownBackground(n, rules) || hiddenEl(n, rules))) return false
    if (n !== surface && (classesOf(n).some((c) => /^text-white(?:\/\d+)?$/.test(c)) || lightText(ownDecls(n, rules)))) return true
    return n.children.some(visit)
  }
  return visit(surface)
}

/** `target` and its ancestors up to and including `footer`, innermost first. */
function chainTo(footer: AstroNode, target: AstroNode): AstroNode[] {
  const path: AstroNode[] = []
  const visit = (n: AstroNode): boolean => {
    if (n === target) return path.push(n) > 0
    if (n.children.some(visit)) return path.push(n) > 0
    return false
  }
  visit(footer)
  return path
}

/**
 * The colour class for links placed in `holder` (#47): the nearest background from `holder` up to
 * the <footer> decides; with none, a light text colour on the footer means dark (text-white/70).
 */
export function linksColour(text: string, root: AstroNode, footer: AstroNode, holder: AstroNode = footer): string | null {
  const rules = baseRules(text, root)
  for (const el of chainTo(footer, holder)) {
    if (el.type !== 'element') continue
    const cls = surfaceClass(el, rules)
    if (cls === UNKNOWN) return whiteTextOn(el, rules) ? 'text-white/70' : null
    if (cls !== undefined) return cls
  }
  return lightText(ownDecls(footer, rules)) ? 'text-white/70' : null
}

/** The row lays its children out itself: Tailwind `flex`/`grid`, or display flex/grid in scoped CSS or inline style. */
function laidOutRow(row: AstroNode, rules: CssRule[]): boolean {
  const LAYOUT = /^(?:inline-)?(?:flex|grid)$/
  if (classesOf(row).some((c) => LAYOUT.test(c))) return true
  const display = lastValue(ownDecls(row, rules), ['display'])
  return display !== undefined && LAYOUT.test(display.replace(/!\s*important\s*$/i, '').trim())
}

type Align = 'start' | 'center' | 'end'
const TEXT_ALIGN: Record<string, Align> = { left: 'start', start: 'start', center: 'center', right: 'end', end: 'end' }
const VARIANTS = ['', 'sm', 'md', 'lg', 'xl', '2xl']

/**
 * The justify-* classes that line the links up with a block row's text (#47): per breakpoint, the
 * nearest text-left/center/right (or scoped `text-align`) on the © element, the row and its
 * ancestors. Base: `justify-start!` unless centred (PrivacyLinks centres itself), `justify-end!`
 * when right-aligned; a breakpoint that changes it gets `md:justify-*!`.
 */
function blockJustify(chain: AstroNode[], rules: CssRule[]): string[] {
  const found = new Map<string, Align>()
  for (const el of chain) {
    if (el.type !== 'element') continue
    for (const c of classesOf(el)) {
      const m = /^(?:(sm|md|lg|xl|2xl):)?text-(left|center|right|start|end)$/.exec(c)
      if (m && !found.has(m[1] ?? '')) found.set(m[1] ?? '', TEXT_ALIGN[m[2]!]!)
    }
    const align = lastValue(ownDecls(el, rules), ['text-align'])?.trim()
    if (align && TEXT_ALIGN[align] && !found.has('')) found.set('', TEXT_ALIGN[align]!)
  }
  const out: string[] = []
  let current: Align = found.get('') ?? 'start'
  if (current !== 'center') out.push(`justify-${current}!`)
  for (const v of VARIANTS.slice(1)) {
    const a = found.get(v)
    if (a && a !== current) {
      out.push(`${v}:justify-${a}!`)
      current = a
    }
  }
  return out
}

/** The PrivacyLinks tag with `classes` (falsy ones left out). */
export function linksTag(name: string, classes: readonly (string | null | false | undefined)[]): string {
  const cls = classes.filter(Boolean)
  return cls.length > 0 ? `<${name} class="${cls.join(' ')}" />` : `<${name} />`
}

/** Where the links go in a footer, with the tag (Rulings 17, 18, 23, 27; #47). */
function inFooter(
  text: string,
  root: AstroNode,
  footer: AstroNode,
  name: string,
  info: Pick<FooterInfo, 'textClass' | 'alignment'>,
  policy: string | null,
  domains: readonly string[],
): { hit: Hit; text: string } {
  const rules = baseRules(text, root)
  const every = allRules(text, root)
  const slot = footerSlot(footer)
  const bar = bottomBar(text, slot)
  const colour = info.textClass ?? linksColour(text, root, footer, bar ? bar.row : slot)
  if (!bar) return lastChildOf(text, slot, linksTag(name, [colour, info.alignment === 'left' && 'justify-start!']))
  const layout = laidOutRow(bar.row, rules) ? [] : [...blockJustify([bar.mark, ...chainTo(footer, bar.row)], rules), 'mt-2']
  const tag = linksTag(name, [colour, ...layout])
  // #65: every link to the policy in the row, the © line's, conditional and component ones included.
  // Only in a real bar: when © sits straight in the slot, the "bar" is the whole footer (link columns too).
  const found = policy === null || bar.row === slot ? [] : policyLinks(bar.row, bar.mark, policy, domains, every)
  const own = policy === null ? [] : contentChildren(bar.row).filter((k) => k !== bar.mark && isLinkTo(text, k, policy, domains))
  if (own.length === 1 && found.filter((f) => !within(own[0]!, f.link)).length === 0) return { hit: { start: own[0]!.start, end: own[0]!.end }, text: tag }
  const deep = deepPolicyLink(found, every)
  if (deep) {
    const here = info.textClass ?? linksColour(text, root, footer, deep.parent)
    const justify = laidOutRow(deep.parent, rules) ? [] : blockJustify(chainTo(footer, deep.parent), rules)
    return { hit: { start: deep.link.start, end: deep.link.end }, text: linksTag(name, [here, ...justify]) }
  }
  if (boxed(bar.mark, every)) return wrapMark(text, root, footer, bar, name, info, rules)
  return afterNode(text, bar.mark, tag)
}

/** `inner` is `outer` or inside it. */
const within = (outer: AstroNode, inner: AstroNode): boolean => inner.start >= outer.start && inner.end <= outer.end

/** Elements that may hold the © line and be wrapped: phrasing that takes no <nav> itself. */
const WRAPPABLE = new Set(['p', 'span', 'small'])

/**
 * A layout class: a container, padding, a max width or auto side margins (site 1369745148:
 * `site-container py-5`). With one, the © element is the bar's box, and links beside it would sit
 * outside the box, against the viewport edge. A `<span>` or `<small>` with padding only is inline
 * spacing (`<span class="px-2">© Firma</span> | …`): it needs a box class.
 */
const BOX_CLASS = /^(?:[\w-]+:)*(?:container|[\w-]+-container|container-[\w-]+|mx-auto|max-w-\S+)$/
const PADDING_CLASS = /^(?:[\w-]+:)*p[xytrblse]?-\S+$/

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A scoped rule (`@media` too) names `el` by its tag, one of its classes or its id, anywhere in a selector. */
function namedBy(el: AstroNode, rules: CssRule[]): boolean {
  const id = attr(el, 'id')
  const names = [
    `(?:^|[\\s>+~,(])${escapeRe(el.name ?? '')}`,
    ...classesOf(el).map((c) => `\\.${escapeRe(c)}`),
    ...(id?.kind === 'quoted' && id.value ? [`#${escapeRe(id.value)}`] : []),
  ]
  const re = new RegExp(`(?:${names.join('|')})(?![\\w-])`, 'i')
  return rules.some((r) => re.test(r.selector))
}

/**
 * The © element is phrasing whose own quoted classes include a layout class (#65, site 1369745148), and no
 * scoped rule names it: moving its classes to a wrapper would lose `p.copy {…}` or `.bar > p {…}`.
 */
function boxed(mark: AstroNode, rules: CssRule[]): boolean {
  if (mark.type !== 'element' || !WRAPPABLE.has(mark.name ?? '') || attr(mark, 'class')?.kind !== 'quoted') return false
  const cls = classesOf(mark)
  const layout = cls.some((c) => BOX_CLASS.test(c)) || (mark.name === 'p' && cls.some((c) => PADDING_CLASS.test(c)))
  return layout && !namedBy(mark, rules)
}

/** White space is kept as written somewhere in `chain` (a whitespace-pre* class, an inline white-space: pre*), so a re-indent would show. */
const keepsWhitespace = (chain: AstroNode[]): boolean =>
  chain.some((el) => {
    if (classesOf(el).some((c) => /(?:^|:)whitespace-pre(?:-wrap|-line)?$/.test(c))) return true
    const style = attr(el, 'style')
    return style?.kind === 'quoted' && declarations(style.value).some((d) => d.prop === 'white-space' && /^pre/i.test(d.value.trim()))
  })

/**
 * #65 (site 1369745148, hand fix b7a90fa): a `<div>` takes over the © element's classes and holds it and the
 * links, so the links sit in the same box. The links' classes are those of a © bar row with the
 * © element's classes as the row: nothing in a flex or grid box, else the block row's justify-*
 * and `mt-2`. Each line of the © element after the first moves one indent deeper, unless it holds
 * a template literal or keeps its white space (whitespace-pre*), where a re-indent would change the text.
 */
function wrapMark(
  text: string,
  root: AstroNode,
  footer: AstroNode,
  bar: BottomBar,
  name: string,
  info: Pick<FooterInfo, 'textClass'>,
  rules: CssRule[],
): { hit: Hit; text: string } {
  const { mark } = bar
  const cls = mark.attributes.find((a) => a.name === 'class')!
  const colour = info.textClass ?? linksColour(text, root, footer, mark)
  const layout = laidOutRow(mark, rules) ? [] : [...blockJustify([mark, ...chainTo(footer, bar.row)], rules), 'mt-2']
  const tag = linksTag(name, [colour, ...layout])
  const attrStart = /\s*$/.exec(text.slice(mark.start, cls.start))!.index + mark.start
  const bare = text.slice(mark.start, attrStart) + text.slice(cls.end, mark.end)
  const open = `<div class="${cls.value}">`
  const hit = { start: mark.start, end: mark.end }
  const endsLine = /^[ \t]*(?:\r?\n|$)/.test(text.slice(mark.end))
  if (!(startsLine(text, mark.start) && endsLine)) return { hit, text: `${open}${bare}${tag}</div>` }
  const eol = eolOf(text)
  const indent = indentAt(text, mark.start)
  const step = indent.includes('\t') ? '\t' : '  '
  const body = bare.includes('`') || keepsWhitespace(chainTo(footer, mark)) ? bare : bare.replace(/\n(?=[^\r\n])/g, `\n${step}`)
  return { hit, text: `${open}${eol}${indent}${step}${body}${eol}${indent}${step}${tag}${eol}${indent}</div>` }
}

/** Where the links go on a footerless page (Rulings 16, 29). */
function pageSlots(root: AstroNode): AstroNode[] {
  const mains = elements(root, 'main')
  if (mains.length > 0) {
    return mains.map((main) => {
      const kids = childElements(main)
      return kids.length === 1 && enterable(kids[0]!) ? kids[0]! : main
    })
  }
  const top = childElements(root).filter((n) => n.type !== 'expression')
  if (top.length === 1 && top[0]!.type === 'element' && top[0]!.name === 'html') return elements(top[0]!, 'body')
  return top
}

export function wireLinks(planner: Planner, report: Report): void {
  const byFile = new Map<string, FooterInfo[]>()
  for (const f of report.footers) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f])
  const policy = policyPath(planner, report)

  for (const [file, footers] of byFile) {
    const target = `links (${file})`
    if (footers.length > 1) {
      planner.refuse(file, target, `ambiguous: ${footers.length} <footer> elements in ${file}`)
      continue
    }
    const info = footers[0]!
    const name = wireImport(planner, file, 'PrivacyLinks')
    const footerAt = (root: AstroNode): AstroNode[] => elements(root, 'footer').filter((n) => n.start === info.start)
    spliceTarget(
      planner,
      target,
      file,
      () => footerAt(parseFile(planner, file).tree.root).some((f) => usesOf(f, name).length > 0),
      () => {
        const { text, tree } = parseFile(planner, file)
        return footerAt(tree.root).map((f) => inFooter(text, tree.root, f, name, info, policy, report.domains))
      },
      // An insert is an empty replace; the bar's own policy link is replaced (#47).
      'replace',
    )
  }

  for (const file of report.footerless) {
    const target = `links (${file})`
    const name = wireImport(planner, file, 'PrivacyLinks')
    const tag = linksTag(name, ['mt-6'])
    spliceTarget(
      planner,
      target,
      file,
      () => usesOf(parseFile(planner, file).tree.root, name).length > 0,
      () => {
        const { text, tree } = parseFile(planner, file)
        return pageSlots(tree.root).map((slot) => lastChildOf(text, slot, tag))
      },
    )
  }
}
