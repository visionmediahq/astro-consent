// Wires <PrivacyLinks /> into every client footer and every footerless page.
//
// Footer (Rulings 17, 23, 29): from <footer>, descend through elements with exactly one element child
// (decoration not counted, phrasing/interactive elements never entered) and append to the first element with more than one, or to the deepest
// single-child wrapper. The class is the footer's own text colour class, plus `justify-start!`
// when the footer's end is left-aligned or split (Rulings 18, 27: alignment === 'left' only).
//
// Footerless page (Rulings 11, 16, 26: detect's `footerless` already leaves out pages a footer
// reaches and CMS admin pages): the last child of <main>'s only element child, or of <main>; with
// no <main>, of the outermost template element (<body> when that is <html>).
import { type AstroNode, attr, elements } from '../lib/astro-ast'
import type { FooterInfo, Report } from '../types'
import type { Planner } from './engine'
import { childElements, lastChildOf, parseFile, spliceTarget, usesOf, wireImport } from './markup'

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

/** Where the links go in a footer (Rulings 17, 23). */
export function footerSlot(footer: AstroNode): AstroNode {
  let node = footer
  for (;;) {
    const kids = contentChildren(node)
    const only = kids.length === 1 ? kids[0]! : null
    if (!only || !enterable(only) || contentChildren(only).length === 0) return node
    node = only
  }
}

/** The PrivacyLinks tag for a footer: its text colour class, and `justify-start!` when left-aligned. */
export function linksTag(name: string, footer: Pick<FooterInfo, 'textClass' | 'alignment'> | null): string {
  const classes = [footer?.textClass, footer?.alignment === 'left' ? 'justify-start!' : null].filter(Boolean)
  return classes.length > 0 ? `<${name} class="${classes.join(' ')}" />` : `<${name} />`
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

  for (const [file, footers] of byFile) {
    const target = `links (${file})`
    if (footers.length > 1) {
      planner.refuse(file, target, `ambiguous: ${footers.length} <footer> elements in ${file}`)
      continue
    }
    const info = footers[0]!
    const name = wireImport(planner, file, 'PrivacyLinks')
    const tag = linksTag(name, info)
    const footerAt = (root: AstroNode): AstroNode[] => elements(root, 'footer').filter((n) => n.start === info.start)
    spliceTarget(
      planner,
      target,
      file,
      () => footerAt(parseFile(planner, file).tree.root).some((f) => usesOf(f, name).length > 0),
      () => {
        const { text, tree } = parseFile(planner, file)
        return footerAt(tree.root).map((f) => lastChildOf(text, footerSlot(f), tag))
      },
    )
  }

  for (const file of report.footerless) {
    const target = `links (${file})`
    const name = wireImport(planner, file, 'PrivacyLinks')
    const tag = linksTag(name, null)
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
