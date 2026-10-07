// Wires the shared layout: <ConsentBanner /> right before the layout's footer component (detect's
// footerRef, under whatever local name the layout imports it), else right before its own <footer>
// element, else as the last child of <body>.
import { elements } from '../lib/astro-ast'
import type { Report } from '../types'
import type { Planner } from './engine'
import { beforeNode, lastChildOf, parseFile, spliceTarget, usesOf, wireImport, withParents } from './markup'

export function wireLayout(planner: Planner, report: Report): void {
  const used = report.layouts.filter((l) => l.pages.length > 0)
  if (used.length !== 1) {
    const reason = used.length === 0 ? 'no layout renders <html>/<body> for any page' : `no single shared layout: ${used.map((l) => l.file).join(', ')}`
    planner.refuse('', 'banner', reason)
    return
  }
  const layout = used[0]!
  const file = layout.file
  const name = wireImport(planner, file, 'ConsentBanner')
  const tag = `<${name} />`
  const footerStarts = new Set(report.footers.filter((f) => f.file === file).map((f) => f.start))

  spliceTarget(
    planner,
    `banner (${file})`,
    file,
    () => usesOf(parseFile(planner, file).tree.root, name).length > 0,
    () => {
      const { text, tree } = parseFile(planner, file)
      const ref = layout.footerRef?.name
      const isFooter = ref
        ? (n: { type: string; name?: string }) => n.type === 'component' && n.name === ref
        : (n: { type: string; name?: string; start: number }) => n.type === 'element' && n.name === 'footer' && footerStarts.has(n.start)
      if (!ref && footerStarts.size === 0) return elements(tree.root, 'body').map((body) => lastChildOf(text, body, tag))
      // A footer rendered inside `{…}` gets the banner before the whole expression.
      return withParents(tree.root, isFooter).map(({ node, parent }) => beforeNode(text, parent.type === 'expression' ? parent : node, tag))
    },
  )
}
