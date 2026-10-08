// Wires astro.config.*: imports the integration after the last import, and appends `consent()` to
// `integrations` (or adds `integrations: [consent()]` as the last property of defineConfig({…})).
// The new text follows the file's own style: line endings, indentation, quotes, semicolons and
// trailing commas.
import ts from 'typescript'
import type { Report } from '../types'
import { findDefineConfig, importsOf, parseModule, topLevelConst } from '../lib/ts-ast'
import { eolOf, type Hit, type Planner } from './engine'

export const PACKAGE = '@visionmediahq/astro-consent'
const IMPORT = 'config import'
const INTEGRATIONS = 'config integrations'

/** The whitespace that starts the line `pos` is on. */
function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

const hasNewline = (text: string, from: number, to: number): boolean => /[\r\n]/.test(text.slice(from, to))

function integrationsProps(obj: ts.ObjectLiteralExpression): ts.ObjectLiteralElementLike[] {
  return obj.properties.filter((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return p.name.text === 'integrations'
    if (!ts.isPropertyAssignment(p)) return false
    const key = p.name
    return (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && key.text === 'integrations'
  })
}

/**
 * Where `item` goes at the end of a list (array elements or object properties) between `open` and
 * `close` (the offsets of its brackets), and the text to insert there.
 */
function appendToList(text: string, list: ts.NodeArray<ts.Node>, open: number, close: number, item: string, sf: ts.SourceFile): { hit: Hit; text: string } {
  const eol = eolOf(text)
  const last = list[list.length - 1]
  if (!last) {
    // `[]` → `[item]`; `{}` → `{ item }`.
    const pad = text[open] === '{' ? ' ' : ''
    return { hit: { start: open + 1, end: open + 1 }, text: `${pad}${item}${pad}` }
  }
  const first = list[0]!
  const multiLine = hasNewline(text, open + 1, first.getStart(sf)) || hasNewline(text, list.end, close)
  const sep = multiLine ? `${eol}${indentAt(text, last.getStart(sf))}` : ' '
  if (!list.hasTrailingComma) return { hit: { start: last.end, end: last.end }, text: `,${sep}${item}` }
  // list.end is just after the trailing comma; a comment after it on the same line stays there.
  const rest = multiLine ? /^[ \t]*(?:\/\/[^\r\n]*|\/\*[^\r\n]*?\*\/[ \t]*)?(?=\r?\n)/.exec(text.slice(list.end)) : null
  const at = list.end + (rest ? rest[0].length : 0)
  return { hit: { start: at, end: at }, text: `${sep}${item},` }
}

export function wireConfig(planner: Planner, report: Report): void {
  const file = report.config.path
  if (!file || !planner.files.exists(file)) {
    planner.refuse(file, INTEGRATIONS, 'no astro.config.* found')
    return
  }
  const text = planner.files.read(file)
  const sf = parseModule(text)
  const imports = importsOf(sf)

  const own = imports.find((i) => i.from === PACKAGE && i.defaultName !== null && !i.typeOnly)
  const name = own?.defaultName ?? 'consent'
  if (!own) {
    const taken =
      imports.some((i) => i.defaultName === name || i.namespace === name || i.named.some((n) => n.local === name)) ||
      topLevelConst(sf, name) !== null ||
      sf.statements.some(
        (s) =>
          ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) ||
          (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)),
      )
    if (taken) {
      planner.refuse(file, IMPORT, `the name '${name}' is already used in ${file}`)
      return
    }
  }

  planner.target(
    IMPORT,
    file,
    () => own !== undefined,
    () => (imports.length > 0 ? [{ start: imports.at(-1)!.start, end: imports.at(-1)!.end }] : []),
    (hit) => {
      const last = text.slice(hit.start, hit.end)
      const quote = /(['"])[^'"]*\1\s*;?\s*$/.exec(last)?.[1] ?? "'"
      const semi = /;\s*$/.test(last) ? ';' : ''
      return `${eolOf(text)}import ${name} from ${quote}${PACKAGE}${quote}${semi}`
    },
    'insert-after',
  )

  const obj = findDefineConfig(sf)
  if (!obj) {
    planner.refuse(file, INTEGRATIONS, 'the config is not defineConfig({…})')
    return
  }
  const props = integrationsProps(obj)
  const arrays = props.map((p) => (ts.isPropertyAssignment(p) && ts.isArrayLiteralExpression(p.initializer) ? p.initializer : null))
  if (props.length === 1 && !arrays[0]) {
    planner.refuse(file, INTEGRATIONS, 'integrations is not an array literal')
    return
  }
  if (props.length === 0 && obj.properties.some(ts.isSpreadAssignment)) {
    planner.refuse(file, INTEGRATIONS, 'defineConfig({…}) has a spread that may already hold integrations')
    return
  }

  const call = `${name}()`
  const isCall = (e: ts.Expression): boolean => ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === name
  // Each candidate list, with the insertion it would get; exactly one must exist.
  const planned =
    props.length === 0
      ? [appendToList(text, obj.properties, obj.getStart(sf), obj.end - 1, `integrations: [${call}]`, sf)]
      : arrays.flatMap((arr) => (arr ? [appendToList(text, arr.elements, arr.getStart(sf), arr.end - 1, call, sf)] : [{ hit: { start: 0, end: 0 }, text: '' }]))
  planner.target(
    INTEGRATIONS,
    file,
    () => arrays.length === 1 && arrays[0] !== null && arrays[0].elements.some(isCall),
    () => planned.map((p) => p.hit),
    (hit) => planned.find((p) => p.hit.start === hit.start)!.text,
    'insert-after',
  )
}
