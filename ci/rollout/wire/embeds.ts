// Wires each registry iframe (a Google Maps embed in this batch) as
// `<ConsentEmbed service=… src=… title=… />`, copying `src` and `title` exactly as written.
// ConsentEmbed takes no class, so the iframe's classes go on a wrapping <div>:
// - a fixed height (Ruling 22: `h-<n>`, `h-[<n>px|rem|em|vh]`, or `height="N"`/`"Npx"`/`"Nrem"`)
//   becomes `grid <height>` on the wrapper, with `aspect="auto"`;
// - an iframe that fills its parent (`height="100%"` or `h-full`) inside a parent of definite height
//   becomes `grid h-full` with `aspect="auto"`; an unknown parent height is a refusal (Ruling 25);
// - otherwise the classes go on the wrapper as they are and the component keeps its own aspect.
// A filter on the iframe is carried over to ConsentEmbed's iframe with `:global(iframe)` (Rulings 19,
// 24): an inline style's `filter` goes into a new scoped rule, and a scoped <style> rule that
// targets the iframe gets a copy after it, under the wrapper, carrying only its `filter` and
// `transition` declarations. The original rule stays as it is.
import { type AstroNode, attr, elements } from '../lib/astro-ast'
import type { IframeInfo, Report } from '../types'
import { eolOf, type Planner, refuseNeedsHuman } from './engine'
import { indentAt, parseFile, spliceTarget, wireImport, withParents } from './markup'

const FIXED_CLASS = /^h-(?:\d+(?:\.\d+)?|\[\d+(?:\.\d+)?(?:px|rem|em|vh)\])$/
const FIXED_ATTR = /^\s*(\d+(?:\.\d+)?)(px|rem)?\s*$/
const DEFINITE = /^(?:\d+(?:\.\d+)?(?:px|rem|em|vh|svh|dvh|lvh)|clamp\(.*\))$/i
const CARRIED = new Set(['filter', 'transition'])

// ── A small CSS reader: rules and declarations with their offsets. Not a CSS parser. ──

export interface CssDecl {
  prop: string
  value: string
  /** The declaration as written, from its property to its `;` (if any). */
  source: string
  start: number
}

export interface CssRule {
  selector: string
  /** Offset just after the rule's closing `}`. */
  end: number
  /** The text between the braces. */
  body: string
  bodyStart: number
  decls: CssDecl[]
}

/** Offset of the end of a comment or string starting at `i`, or -1 if none starts there. */
function skipOpaque(css: string, i: number): number {
  const c = css[i]
  if (c === '/' && css[i + 1] === '*') {
    const close = css.indexOf('*/', i + 2)
    return close === -1 ? css.length : close + 2
  }
  if (c === '"' || c === "'") {
    let j = i + 1
    while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1
    return j + 1
  }
  return -1
}

/** Declarations in a rule body: split at top-level `;`, comments dropped. */
export function declarations(body: string, offset = 0): CssDecl[] {
  const out: CssDecl[] = []
  let start = 0
  let parens = 0
  const flush = (end: number, withSemi: boolean): void => {
    const raw = body.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const source = raw.trim().replace(/\/\*[\s\S]*?\*\//g, '').trim()
    const colon = source.indexOf(':')
    if (source !== '' && colon > 0) {
      out.push({
        prop: source.slice(0, colon).trim().toLowerCase(),
        value: source.slice(colon + 1).trim(),
        source: withSemi ? `${source};` : source,
        start: offset + start + lead,
      })
    }
  }
  for (let i = 0; i < body.length; i++) {
    const skip = skipOpaque(body, i)
    if (skip !== -1) {
      i = skip - 1
      continue
    }
    const c = body[i]
    if (c === '(') parens++
    else if (c === ')') parens = Math.max(0, parens - 1)
    else if (c === ';' && parens === 0) {
      flush(i, true)
      start = i + 1
    }
  }
  flush(body.length, false)
  return out
}

/** Style rules (not at-rules) with no nested blocks, at any depth, in source order. */
export function cssRules(css: string, offset = 0): CssRule[] {
  const out: CssRule[] = []
  const stack: { prelude: string; bodyStart: number; nested: boolean }[] = []
  let preludeStart = 0
  for (let i = 0; i < css.length; i++) {
    const skip = skipOpaque(css, i)
    if (skip !== -1) {
      i = skip - 1
      continue
    }
    const c = css[i]
    if (c === '{') {
      if (stack.length > 0) stack[stack.length - 1]!.nested = true
      stack.push({ prelude: css.slice(preludeStart, i).replace(/\/\*[\s\S]*?\*\//g, '').trim(), bodyStart: i + 1, nested: false })
      preludeStart = i + 1
    } else if (c === '}') {
      const block = stack.pop()
      if (block && !block.nested && !block.prelude.startsWith('@')) {
        const body = css.slice(block.bodyStart, i)
        out.push({
          selector: block.prelude,
          end: offset + i + 1,
          body,
          bodyStart: offset + block.bodyStart,
          decls: declarations(body, offset + block.bodyStart),
        })
      }
      preludeStart = i + 1
    } else if (c === ';') {
      preludeStart = i + 1
    }
  }
  return out
}

/** Splits at top-level `sep` characters (outside parentheses and brackets). */
function splitTop(text: string, sep: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && sep.test(c)) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/** The word `iframe` as a type selector somewhere in a selector. */
const IFRAME_WORD = /(?:^|[^\w-])iframe(?![\w-])/

const COMPOUND = /^([a-zA-Z][\w-]*|\*)?((?:\.[\w-]+|::?[\w-]+(?:\([^)]*\))?|#[\w-]+|\[[^\]]*\])*)$/

/**
 * One selector (no commas) rewritten for the wrapper, when its last compound targets the iframe
 * (the `iframe` element, or only classes the iframe has): `X iframe` → `X :global(iframe)`;
 * otherwise the compound moves to the wrapper (`iframe` → `div`, pseudo-classes kept) and
 * ` :global(iframe)` follows: `iframe:hover` → `div:hover :global(iframe)`. Null when the selector
 * does not target the iframe; an Error when it does but cannot be rewritten safely, or when it
 * targets the iframe through one of its classes (Ruling 30: the wrapper keeps those classes).
 */
export function rewriteSelector(selector: string, iframeClasses: readonly string[]): { selector: string; div: boolean } | null | Error {
  const sel = selector.trim()
  // The last compound and the combinator before it.
  const m = /^(.*?)(\s*[>+~]\s*|\s+)?([^\s>+~]+)$/s.exec(sel)
  if (!m) return IFRAME_WORD.test(sel) ? new Error(`cannot rewrite the style selector '${sel}' for the map's wrapper`) : null
  const ancestor = (m[1] ?? '').trim()
  const combinator = (m[2] ?? '').trim()
  const compound = COMPOUND.exec(m[3]!)
  if (!compound) {
    return IFRAME_WORD.test(m[3]!) || iframeClasses.some((c) => m[3]!.includes(`.${c}`))
      ? new Error(`cannot rewrite the style selector '${sel}' for the map's wrapper`)
      : null
  }
  const type = compound[1]
  const parts = compound[2]!.match(/\.[\w-]+|::?[\w-]+(?:\([^)]*\))?|#[\w-]+|\[[^\]]*\]/g) ?? []
  const classes = parts.filter((p) => p.startsWith('.')).map((p) => p.slice(1))
  const targets = (type === 'iframe' || (type === undefined && classes.length > 0)) && classes.every((c) => iframeClasses.includes(c))
  if (!targets) return null
  // Ruling 30: the wrapper keeps the iframe's classes, so the original rule would match the wrapper
  // (filtering the placeholder) and the copy would filter the iframe a second time.
  if (classes.length > 0) return new Error("filter rule targets the iframe's class")
  const pseudos = parts.filter((p) => p.startsWith(':'))
  const unsafe =
    combinator !== '' ||
    parts.some((p) => p.startsWith('#') || p.startsWith('[') || p.startsWith('::') || p.includes('(')) ||
    (m[2] !== undefined && ancestor === '')
  if (unsafe) return new Error(`cannot rewrite the style selector '${sel}' for the map's wrapper`)
  if (type === 'iframe' && classes.length === 0 && pseudos.length === 0 && ancestor !== '') {
    return { selector: `${ancestor} :global(iframe)`, div: false }
  }
  const wrapper = `div${pseudos.join('')}`
  return { selector: `${ancestor ? `${ancestor} ` : ''}${wrapper} :global(iframe)`, div: true }
}

// ── The iframe itself ──

const classList = (n: AstroNode): string[] | null => {
  const cls = attr(n, 'class')
  if (!cls) return n.attributes.some((a) => a.name === 'class:list') ? null : []
  return cls.kind === 'quoted' ? cls.value.split(/\s+/).filter(Boolean) : null
}

/** The scoped (not is:global) <style> elements of a file, with their content's offsets. */
function scopedStyles(text: string, root: AstroNode): { start: number; end: number; node: AstroNode }[] {
  return elements(root, 'style')
    .filter((s) => !s.attributes.some((a) => a.name === 'is:global' || a.name === 'global'))
    .flatMap((s) => {
      const start = text.indexOf('>', s.start) + 1
      const end = text.lastIndexOf('</', s.end - 1)
      return start > 0 && end >= start ? [{ start, end, node: s }] : []
    })
}

/** The parent has a definite height (Ruling 25): a fixed h- class, an inline height, or a scoped CSS height for one of its classes. */
function definiteHeight(parent: AstroNode, rules: CssRule[]): boolean {
  if (parent.type !== 'element') return false
  const classes = classList(parent) ?? []
  if (classes.some((c) => FIXED_CLASS.test(c))) return true
  const isHeight = (d: CssDecl): boolean => (d.prop === 'height' || d.prop === 'min-height') && DEFINITE.test(d.value)
  const style = attr(parent, 'style')
  if (style?.kind === 'quoted' && declarations(style.value).some(isHeight)) return true
  return rules.some(
    (r) => splitTop(r.selector, /,/).some((s) => classes.some((c) => s.trim() === `.${c}`)) && r.decls.some(isHeight),
  )
}

interface Box {
  classes: string[]
  aspect: boolean
}

/** The wrapper's classes and whether the embed takes `aspect="auto"`, or the reason to refuse. */
function boxOf(node: AstroNode, parent: AstroNode, rules: CssRule[]): Box | Error {
  const classes = classList(node)
  if (classes === null) return new Error('iframe class is an expression')
  const fixed = classes.find((c) => FIXED_CLASS.test(c))
  if (fixed) return { classes: ['grid', fixed, ...classes.filter((c) => c !== fixed)], aspect: true }
  // Ruling 31: an inline style height beats the height attribute, as in CSS.
  const style = attr(node, 'style')
  const inlineHeight = style?.kind === 'quoted' ? declarations(style.value).findLast((d) => d.prop === 'height')?.value.trim() : undefined
  const inlineFixed = inlineHeight !== undefined ? /^(\d+(?:\.\d+)?)(px|rem|vh)$/i.exec(inlineHeight) : null
  if (inlineFixed) return { classes: ['grid', `h-[${inlineFixed[1]}${inlineFixed[2]!.toLowerCase()}]`, ...classes], aspect: true }
  const height = attr(node, 'height')
  const fills =
    classes.includes('h-full') ||
    inlineHeight === '100%' ||
    (inlineHeight === undefined && height?.kind === 'quoted' && height.value.trim() === '100%')
  if (fills) {
    if (!definiteHeight(parent, rules)) return new Error('map fills a parent of unknown height')
    return { classes: ['grid', 'h-full', ...classes.filter((c) => c !== 'h-full')], aspect: true }
  }
  const n = inlineHeight !== undefined ? null : height?.kind === 'quoted' ? FIXED_ATTR.exec(height.value) : height?.kind === 'expression' ? /^\s*(\d+)()\s*$/.exec(height.value) : null
  if (n) return { classes: ['grid', `h-[${n[1]}${n[2] || 'px'}]`, ...classes], aspect: true }
  return { classes, aspect: false }
}

/** `name="…"` or `name={…}` exactly as written on the iframe. */
function attrSource(text: string, node: AstroNode, name: string): string | null {
  const a = node.attributes.find((x) => x.kind !== 'spread' && x.name === name)
  return a ? text.slice(a.start, a.end) : null
}

/** A new CSS rule after `rule`, in its layout: multi-line with each declaration on its own line, or one line. */
function ruleCopy(text: string, rule: CssRule, selector: string, decls: CssDecl[]): string {
  const eol = eolOf(text)
  const indent = indentAt(text, rule.bodyStart - 1)
  if (!/\n/.test(rule.body)) return `${eol}${indent}${selector} { ${decls.map((d) => d.source).join(' ')} }`
  const lines = decls.map((d) => `${indentAt(text, d.start)}${d.source}`)
  return `${eol}${eol}${indent}${selector} {${eol}${lines.join(eol)}${eol}${indent}}`
}

function wireFile(planner: Planner, file: string, frames: IframeInfo[]): void {
  let parsed: ReturnType<typeof parseFile>
  try {
    parsed = parseFile(planner, file)
  } catch (e) {
    planner.refuse(file, `embed (${file})`, e instanceof Error ? e.message : String(e))
    return
  }
  const { text, tree } = parsed
  const eol = eolOf(text)
  const styles = scopedStyles(text, tree.root)
  const rules = styles.flatMap((s) => cssRules(text.slice(s.start, s.end), s.start))

  const found = frames.map((f) => ({ info: f, at: withParents(tree.root, (n) => n.type === 'element' && n.name === 'iframe' && n.start === f.start) }))
  const iframeClasses = [...new Set(found.flatMap((f) => (f.at[0] ? (classList(f.at[0].node) ?? []) : [])))]

  // Scoped rules that target the iframe: a copy for the wrapper after each, carrying filter/transition.
  let needsDiv = false
  const copies: { rule: CssRule; text: string }[] = []
  for (const rule of rules) {
    const carried = rule.decls.filter((d) => CARRIED.has(d.prop))
    if (carried.length === 0) continue
    const rewritten: string[] = []
    for (const part of splitTop(rule.selector, /,/)) {
      const r = rewriteSelector(part, iframeClasses)
      if (r instanceof Error) {
        planner.refuse(file, `embed style (${file})`, r.message)
        return
      }
      if (r) {
        rewritten.push(r.selector)
        needsDiv ||= r.div
      }
    }
    if (rewritten.length > 0) copies.push({ rule, text: ruleCopy(text, rule, rewritten.join(', '), carried) })
  }

  // Inline filters go into one new scoped rule under the wrapper div.
  const inline = [
    ...new Set(
      found.flatMap((f) => {
        const style = f.at[0] ? attr(f.at[0].node, 'style') : null
        return style?.kind === 'quoted' ? declarations(style.value).filter((d) => d.prop === 'filter').map((d) => d.value) : []
      }),
    ),
  ]
  if (inline.length > 1) {
    planner.refuse(file, `embed style (${file})`, 'maps in one file have different inline filters')
    return
  }
  if (inline.length === 1) needsDiv = true

  const name = wireImport(planner, file, 'ConsentEmbed')
  for (const { info, at } of found) {
    const target = `embed (${file}:${text.slice(0, info.start).split('\n').length})`
    const hit = at[0]
    if (hit) {
      const title = attrSource(text, hit.node, 'title')
      const titleAttr = attr(hit.node, 'title')
      if (!title || titleAttr?.kind === 'empty' || (titleAttr?.kind === 'quoted' && titleAttr.value.trim() === '')) {
        planner.refuse(file, target, 'iframe has no title')
        continue
      }
      const box = boxOf(hit.node, hit.parent, rules)
      if (box instanceof Error) {
        planner.refuse(file, target, box.message)
        continue
      }
      const id = attrSource(text, hit.node, 'id')
      const props = [`service="${info.service}"`, attrSource(text, hit.node, 'src')!, title, ...(box.aspect ? ['aspect="auto"'] : []), ...(id ? [id] : [])]
      const embed = `<${name} ${props.join(' ')} />`
      const wrapped = box.classes.length > 0 ? `<div class="${box.classes.join(' ')}">${embed}</div>` : needsDiv ? `<div>${embed}</div>` : embed
      spliceTarget(planner, target, file, () => false, () => at.map((a) => ({ hit: { start: a.node.start, end: a.node.end }, text: wrapped })), 'replace')
    } else {
      planner.refuse(file, target, `iframe at offset ${info.start} not found`)
    }
  }

  for (const copy of copies) {
    planner.target(`embed style (${file}:${copy.rule.selector})`, file, () => false, () => [{ start: copy.rule.end, end: copy.rule.end }], () => copy.text, 'insert-after')
  }
  if (inline.length === 1) {
    const filter = `filter: ${inline[0]};`
    const style = styles.at(-1)
    spliceTarget(planner, `embed style (${file}: inline filter)`, file, () => false, () => {
      if (!style) {
        const block = `<style>${eol}  div :global(iframe) {${eol}    ${filter}${eol}  }${eol}</style>${eol}`
        return [{ hit: { start: text.length, end: text.length }, text: `${/\n$/.test(text) ? '' : eol}${block}` }]
      }
      // The new rule goes last in the file's (last) scoped <style>, indented like its rules.
      const lineStart = text.lastIndexOf('\n', style.end - 1) + 1
      const first = rules.find((r) => r.end > style.start && r.end <= style.end)
      const indent = first ? indentAt(text, first.bodyStart - 1) : '  '
      const rule = `${indent}div :global(iframe) {${eol}${indent}${indent || '  '}${filter}${eol}${indent}}`
      return /^[ \t]*$/.test(text.slice(lineStart, style.end))
        ? [{ hit: { start: lineStart, end: lineStart }, text: `${eol}${rule}${eol}` }]
        : [{ hit: { start: style.end, end: style.end }, text: ` ${rule.trim()} ` }]
    })
  }
}

export function wireEmbeds(planner: Planner, report: Report): void {
  if (refuseNeedsHuman(planner, report)) return
  const byFile = new Map<string, IframeInfo[]>()
  for (const frame of report.iframes) {
    if (frame.service === null) continue // the site's own frames are left alone
    if (frame.srcKind === 'unresolved') {
      // A report with one is needs-human; host and service are only hints here.
      planner.refuse(frame.file, 'embed', `unresolved iframe src in ${frame.file}`)
      continue
    }
    byFile.set(frame.file, [...(byFile.get(frame.file) ?? []), frame])
  }
  for (const [file, frames] of byFile) wireFile(planner, file, frames)
}
