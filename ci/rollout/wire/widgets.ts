// Wires each Elfsight widget detect recognised: the div is wrapped in
// `<ConsentWidget service="elfsight" script="<loader as written>" title="Innehållet">`, and the
// file's own loader <script> is removed, so the loader only runs after a grant. The div's text is
// kept exactly as written; the wrapper's tags go on lines of their own at the div's indent.
//
// The loader line goes when the script is alone on it; otherwise only the element. A div that does
// not start its line is refused: its wrapper would share a line with other markup.
import type { AstroNode } from '../lib/astro-ast'
import type { Report, WidgetInfo } from '../types'
import { eolOf, type Planner, refuseNeedsHuman } from './engine'
import { indentAt, parseFile, startsLine, wireImport } from './markup'

const TITLE = 'Innehållet'

/** The element named `name` that spans exactly [start, end). */
function elementAt(root: AstroNode, name: string, start: number, end: number): AstroNode | null {
  let found: AstroNode | null = null
  const visit = (n: AstroNode): void => {
    if (found) return
    if (n.type === 'element' && n.name === name && n.start === start && n.end === end) found = n
    else n.children.forEach(visit)
  }
  visit(root)
  return found
}

/** The span to delete for the script: its whole line when it is alone on it, else the element. */
function scriptSpan(text: string, start: number, end: number): { start: number; end: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const rest = /^[ \t]*(?:\r?\n|$)/.exec(text.slice(end))
  return startsLine(text, start) && rest ? { start: lineStart, end: end + rest[0].length } : { start, end }
}

function wireFile(planner: Planner, file: string, widgets: WidgetInfo[]): void {
  let text: string
  let root: AstroNode
  try {
    ;({ text, tree: { root } } = parseFile(planner, file))
  } catch (e) {
    planner.refuse(file, `widget (${file})`, e instanceof Error ? e.message : String(e))
    return
  }
  const scriptAt = widgets[0]!.scriptAt
  if (widgets.some((w) => w.scriptAt.start !== scriptAt.start || w.scriptAt.end !== scriptAt.end)) {
    planner.refuse(file, `widget script (${file})`, 'widgets in one file name different scripts')
    return
  }

  const name = wireImport(planner, file, 'ConsentWidget')
  const eol = eolOf(text)
  for (const w of widgets) {
    const target = `widget (${file}:${text.slice(0, w.start).split('\n').length})`
    const div = elementAt(root, 'div', w.start, w.end)
    if (!div) {
      planner.refuse(file, target, `widget div at offset ${w.start} not found`)
      continue
    }
    if (!startsLine(text, div.start)) {
      planner.refuse(file, target, 'widget div does not start its line')
      continue
    }
    const indent = indentAt(text, div.start)
    const open = `<${name} service="${w.service}" script="${w.script}" title="${TITLE}">`
    const wrapped = `${open}${eol}${indent}${text.slice(div.start, div.end)}${eol}${indent}</${name}>`
    planner.target(target, file, () => false, () => [{ start: div.start, end: div.end }], () => wrapped, 'replace')
  }

  const target = `widget script (${file})`
  const script = elementAt(root, 'script', scriptAt.start, scriptAt.end)
  if (!script) {
    planner.refuse(file, target, `widget script at offset ${scriptAt.start} not found`)
    return
  }
  const span = scriptSpan(text, script.start, script.end)
  planner.target(target, file, () => false, () => [span], () => '', 'replace')
}

export function wireWidgets(planner: Planner, report: Report): void {
  if (refuseNeedsHuman(planner, report)) return
  const byFile = new Map<string, WidgetInfo[]>()
  for (const w of report.widgets) byFile.set(w.file, [...(byFile.get(w.file) ?? []), w])
  for (const [file, widgets] of byFile) wireFile(planner, file, widgets)
}
