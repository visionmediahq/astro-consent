// Wires <PrivacyLinks /> into every client footer and every footerless page.
//
// Footer (Rulings 17, 23, 29): from <footer>, descend through elements with exactly one element child
// (decoration not counted, phrasing/interactive elements never entered) to the first element with
// more than one, or to the deepest single-child wrapper: the slot.
//
// The © bottom bar (#47): when a child of the slot holds the copyright line (`©`, `&copy;`,
// "Copyright", "Alla rättigheter"), the links go into that bar: the last such child, descending
// into whichever child holds the line until the element that holds it directly, and the links
// follow that element as its sibling, in its row. A link in that row to the policy page that
// PrivacyLinks will render itself (policy_url) is replaced by the links. With no © bar, the links
// are the slot's last child, as before.
//
// The class: the footer's own text colour class. With none, `text-white/70` when the footer is dark
// as far as its markup shows (its inline style, its scoped CSS rule, a Tailwind bg-* class, or a
// light text colour there); otherwise nothing, and verify's contrast step decides. `justify-start!`
// when the footer's end is left-aligned or split (Rulings 18, 27: alignment === 'left' only),
// unless the links sit in a flex row of the © bar, which places them itself.
//
// Footerless page (Rulings 11, 16, 26: detect's `footerless` already leaves out pages a footer
// reaches and CMS admin pages): the last child of <main>'s only element child, or of <main>; with
// no <main>, of the outermost template element (<body> when that is <html>). Class `mt-6`, so the
// links do not touch the button above them (#47).
import { type AstroNode, attr, elements } from '../lib/astro-ast'
import { type Rgb, wcagContrast } from '../lib/colour'
import type { FooterInfo, Report } from '../types'
import { type CssDecl, cssRules, declarations, ownRules, scopedStyles } from './embeds'
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

const COPYRIGHT = /©|&copy;|&#169;|&#xa9;|\bcopyright\b|alla rättigheter/i

/** The text written directly in `n`, not in its child elements. */
const ownText = (text: string, n: AstroNode): string =>
  n.children
    .filter((c) => c.type === 'text')
    .map((c) => text.slice(c.start, c.end))
    .join('')

/** `n` or anything rendered inside it holds the copyright line. */
function holdsCopyright(text: string, n: AstroNode): boolean {
  if (n.type === 'text') return COPYRIGHT.test(text.slice(n.start, n.end))
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
    const deeper = enterable(mark) && !COPYRIGHT.test(ownText(text, mark)) && contentChildren(mark).some((k) => holdsCopyright(text, k))
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
    if (n.name === 'a') {
      const href = attr(n, 'href')
      return href?.kind === 'quoted' && pathOf(href.value, domains) === path
    }
    const kids = contentChildren(n)
    if (kids.length !== 1 || ownText(text, n).trim() !== '') return false
    n = kids[0]!
  }
}

/** `markup` right after `node`: on its own line at the node's indent when the node ends its line, inline otherwise. */
function afterNode(text: string, node: AstroNode, markup: string): { hit: Hit; text: string } {
  const hit = { start: node.end, end: node.end }
  const endsLine = /^[ \t]*(?:\r?\n|$)/.test(text.slice(node.end))
  return { hit, text: startsLine(text, node.start) && endsLine ? `${eolOf(text)}${indentAt(text, node.start)}${markup}` : markup }
}

// ── The footer's colours, as far as its markup shows ──

const DARK_SHADE = /^bg-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:900|950)$/
const LIGHT_SHADE = /^bg-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200)$/

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

/**
 * The footer is dark, as far as its markup shows. The background decides when it is a literal
 * colour (the last `background`/`background-color` of the footer's scoped rules, then its inline
 * style), then a Tailwind bg-* class; with neither, a light text colour set there means a dark
 * footer. Anything else (variables, gradients, transparency, a theme colour) is unknown: false.
 */
export function darkFooter(text: string, root: AstroNode, footer: AstroNode): boolean {
  const rules = scopedStyles(text, root)
    .flatMap((s) => cssRules(text.slice(s.start, s.end), s.start))
    .filter((r) => !r.media)
  const own = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === 'footer') || ownRules(footer, [r]).length > 0)
  const style = attr(footer, 'style')
  const decls: CssDecl[] = [...own.flatMap((r) => r.decls), ...(style?.kind === 'quoted' ? declarations(style.value) : [])]
  const last = (props: string[]): string | undefined => decls.findLast((d) => props.includes(d.prop))?.value

  const bgValue = last(['background', 'background-color'])
  if (bgValue !== undefined) {
    const bg = cssColour(bgValue)
    if (bg && bg.a === 1) return white70Readable(bg)
  }
  const classes = classesOf(footer)
  for (const c of classes) {
    if (c === 'bg-black' || DARK_SHADE.test(c)) return true
    if (c === 'bg-white' || LIGHT_SHADE.test(c)) return false
    const arbitrary = /^bg-\[(#[0-9a-fA-F]{3,8})\]$/.exec(c)
    const bg = arbitrary ? cssColour(arbitrary[1]!) : null
    if (bg && bg.a === 1) return white70Readable(bg)
  }
  const fgValue = last(['color'])
  const fg = fgValue === undefined ? null : cssColour(fgValue)
  return fg !== null && wcagContrast(fg, BLACK) > wcagContrast(fg, WHITE)
}

/** The bar's row lays its children out in a flex row (Tailwind `flex`, scoped CSS or inline style). */
function flexRow(text: string, root: AstroNode, row: AstroNode): boolean {
  const FLEX = /^(?:inline-)?flex$/
  if (classesOf(row).some((c) => FLEX.test(c))) return true
  const rules = scopedStyles(text, root)
    .flatMap((s) => cssRules(text.slice(s.start, s.end), s.start))
    .filter((r) => !r.media)
  const style = attr(row, 'style')
  const decls = [...ownRules(row, rules).flatMap((r) => r.decls), ...(style?.kind === 'quoted' ? declarations(style.value) : [])]
  const display = decls.findLast((d) => d.prop === 'display')?.value
  return display !== undefined && FLEX.test(display.replace(/!\s*important\s*$/i, '').trim())
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
  const slot = footerSlot(footer)
  const bar = bottomBar(text, slot)
  const colour = info.textClass ?? (darkFooter(text, root, footer) ? 'text-white/70' : null)
  const left = info.alignment === 'left' && !(bar && flexRow(text, root, bar.row))
  const tag = linksTag(name, [colour, left && 'justify-start!'])
  if (!bar) return lastChildOf(text, slot, tag)
  const own = policy === null ? [] : contentChildren(bar.row).filter((k) => k !== bar.mark && isLinkTo(text, k, policy, domains))
  if (own.length === 1) return { hit: { start: own[0]!.start, end: own[0]!.end }, text: tag }
  return afterNode(text, bar.mark, tag)
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
