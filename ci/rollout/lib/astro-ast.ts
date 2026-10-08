// A small, typed view of an .astro file, built on @astrojs/compiler-rs.
//
// The compiler returns an untyped ESTree/JSX tree (`ast: Record<string, any>`) with flat UTF-16
// `start`/`end` offsets, so `text.slice(node.start, node.end)` is exact, åäö included. This module
// maps that tree into AstroNode and keeps only what the rollout reads: elements, components,
// attributes and their offsets. Content that is not live markup has no children here: comments,
// the bodies of script, style and textarea, is:raw content (already text in the compiler's tree),
// and JS comments and strings inside `{…}` expressions.
import { parse } from '@astrojs/compiler-rs'

export type AstroNodeType =
  | 'root'
  | 'element' // lower-case tag: <footer>, <iframe>, <my-widget>
  | 'component' // capitalised or dotted name: <Footer>, <UI.Card>, <Fragment>
  | 'fragment' // <>…</>
  | 'expression' // {…}; children are the JSX elements found inside it
  | 'text'
  | 'comment'
  | 'doctype'
  | 'other'

export interface AstroAttribute {
  /** As written (`class:list`, `is:raw`); empty for a spread. */
  name: string
  /**
   * quoted: a literal value, quoted or not, exactly as written (`&amp;` is not decoded).
   * expression: the source of the `{…}` expression (or of a template-literal value, backticks included).
   * empty: a bare attribute (`allowfullscreen`). spread: `{...rest}`, value is the spread argument.
   */
  kind: 'quoted' | 'expression' | 'empty' | 'spread'
  value: string
  start: number
  end: number
}

export interface AstroNode {
  type: AstroNodeType
  name?: string
  attributes: AstroAttribute[]
  children: AstroNode[]
  start: number
  end: number
}

export interface Frontmatter {
  /** The text between the `---` fences, newlines included; `source.slice(start, end) === text`. */
  text: string
  start: number
  end: number
}

interface Raw {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

const isRaw = (v: unknown): v is Raw =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string'

/** Elements whose content is text, not markup, for the rollout's purposes. */
const OPAQUE = new Set(['script', 'style', 'textarea'])

function nameOf(raw: unknown): string {
  if (!isRaw(raw)) return ''
  if (raw.type === 'JSXIdentifier') return String(raw['name'])
  if (raw.type === 'JSXMemberExpression') return `${nameOf(raw['object'])}.${nameOf(raw['property'])}`
  if (raw.type === 'JSXNamespacedName') return `${nameOf(raw['namespace'])}:${nameOf(raw['name'])}`
  return ''
}

function attribute(raw: Raw, text: string): AstroAttribute | null {
  const at = { start: raw.start, end: raw.end }
  if (raw.type === 'JSXSpreadAttribute') {
    const arg = raw['argument']
    return { name: '', kind: 'spread', value: isRaw(arg) ? text.slice(arg.start, arg.end) : '', ...at }
  }
  if (raw.type !== 'JSXAttribute') return null
  const name = nameOf(raw['name'])
  const value = raw['value']
  if (value === null || value === undefined) return { name, kind: 'empty', value: '', ...at }
  if (!isRaw(value)) return null
  if (value.type === 'Literal') return { name, kind: 'quoted', value: String(value['value']), ...at }
  if (value.type === 'JSXExpressionContainer') {
    const expr = value['expression']
    const source = isRaw(expr) && expr.type !== 'JSXEmptyExpression' ? text.slice(expr.start, expr.end) : ''
    return { name, kind: 'expression', value: source, ...at }
  }
  return null
}

/** JSX elements and fragments anywhere inside a JS expression, outermost first, in source order. */
function jsxIn(value: unknown, text: string, out: AstroNode[]): void {
  if (Array.isArray(value)) {
    for (const v of value) jsxIn(v, text, out)
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (isRaw(value) && (value.type === 'JSXElement' || value.type === 'JSXFragment')) {
    out.push(convert(value, text))
    return
  }
  for (const [key, v] of Object.entries(value)) {
    if (key !== 'loc') jsxIn(v, text, out)
  }
}

function convertChildren(list: unknown, text: string): AstroNode[] {
  return Array.isArray(list) ? list.filter(isRaw).map((c) => convert(c, text)) : []
}

function convert(raw: Raw, text: string): AstroNode {
  const base = { attributes: [] as AstroAttribute[], children: [] as AstroNode[], start: raw.start, end: raw.end }
  switch (raw.type) {
    case 'JSXElement': {
      const opening = raw['openingElement']
      const name = isRaw(opening) ? nameOf(opening['name']) : ''
      const attrs = isRaw(opening) && Array.isArray(opening['attributes']) ? opening['attributes'] : []
      const isComponent = name.includes('.') || /^[A-Z]/.test(name)
      return {
        ...base,
        type: isComponent ? 'component' : 'element',
        name,
        attributes: attrs.filter(isRaw).flatMap((a) => attribute(a, text) ?? []),
        children: !isComponent && OPAQUE.has(name) ? [] : convertChildren(raw['children'], text),
      }
    }
    case 'JSXFragment':
      return { ...base, type: 'fragment', children: convertChildren(raw['children'], text) }
    case 'JSXExpressionContainer': {
      const children: AstroNode[] = []
      jsxIn(raw['expression'], text, children)
      return { ...base, type: 'expression', children }
    }
    case 'JSXText':
      return { ...base, type: 'text' }
    case 'AstroComment':
      return { ...base, type: 'comment' }
    case 'AstroDoctype':
      return { ...base, type: 'doctype' }
    default:
      return { ...base, type: 'other' }
  }
}

function frontmatterOf(raw: unknown, text: string): Frontmatter | null {
  if (!isRaw(raw) || (raw.start === 0 && raw.end === 0)) return null
  // The compiler's span runs from any leading whitespace to the end of the closing fence.
  const block = text.slice(raw.start, raw.end)
  const open = block.indexOf('---')
  if (open < 0 || !block.endsWith('---') || block.length - open < 6) {
    throw new Error(`unexpected frontmatter span ${raw.start}-${raw.end}`)
  }
  const start = raw.start + open + 3
  const end = raw.end - 3
  return { text: text.slice(start, end), start, end }
}

/**
 * Parses an .astro file. Throws on a compiler error: its tree is not trustworthy then (it holds a
 * placeholder element named `this` at 0-0), and the caller should hand the file to a human.
 */
export function parseAstro(text: string): { frontmatter: Frontmatter | null; root: AstroNode } {
  const { ast, diagnostics } = parse(text)
  const errors = diagnostics.filter((d) => d.severity === 'error')
  if (errors.length > 0) {
    const where = (d: (typeof errors)[number]): string => {
      const label = d.labels[0]
      return label ? ` (${label.line}:${label.column})` : ''
    }
    throw new Error(`Astro parse error: ${errors.map((d) => `${d.text}${where(d)}`).join('; ')}`)
  }
  const root: AstroNode = {
    type: 'root',
    attributes: [],
    children: convertChildren(ast['body'], text),
    start: 0,
    end: text.length,
  }
  return { frontmatter: frontmatterOf(ast['frontmatter'], text), root }
}

function collect(root: AstroNode, match: (n: AstroNode) => boolean): AstroNode[] {
  const out: AstroNode[] = []
  const visit = (n: AstroNode): void => {
    if (match(n)) out.push(n)
    n.children.forEach(visit)
  }
  visit(root)
  return out
}

/** HTML elements named `tag` (case-sensitive, as written), in document order. */
export function elements(root: AstroNode, tag: string): AstroNode[] {
  return collect(root, (n) => n.type === 'element' && n.name === tag)
}

/** Uses of the component `name` (`Footer`, `UI.Card`), in document order. */
export function components(root: AstroNode, name: string): AstroNode[] {
  return collect(root, (n) => n.type === 'component' && n.name === name)
}

/** The attribute `name` on `node`, or null when absent. Spreads are never matched. */
export function attr(
  node: AstroNode,
  name: string,
): { kind: 'quoted' | 'expression' | 'empty'; value: string } | null {
  const a = node.attributes.find((x) => x.kind !== 'spread' && x.name === name)
  return a && a.kind !== 'spread' ? { kind: a.kind, value: a.value } : null
}
