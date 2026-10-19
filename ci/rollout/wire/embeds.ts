// Wires each registry iframe (a Google Maps embed in this batch) as
// `<ConsentEmbed service=… src=… title=… />`, copying `src` and `title` exactly as written.
// ConsentEmbed takes no class, so the iframe's classes go on a wrapping <div>:
// - a fixed height (Ruling 22: `h-<n>`, `h-[<n>px|rem|em|vh]`, or `height="N"`/`"Npx"`/`"Nrem"`)
//   becomes `grid <height>` on the wrapper, with `aspect="auto"`;
// - an iframe that fills its parent (`height="100%"` or `h-full`) inside a parent of definite height
//   becomes `grid h-full` with `aspect="auto"`; an unknown parent height is a refusal (Ruling 25);
//   a parent with only a min-height (`min-h-*` classes, or a CSS `min-height`) is not a definite
//   height: `h-full` would resolve to auto there and shrink to the placeholder, so the wrapper carries
//   the min-height (`grid h-full min-h-[500px]`). The iframe's own inline min-height goes along too;
// - a scoped rule that sets the iframe's height (`.box iframe { height: 100% }`) beats its height
//   attribute and a layered Tailwind height, as in CSS (#43); an inline style still beats the rule;
// - an iframe absolutely positioned to fill a `position: relative` parent (#45, knutssonsbil's
//   padding-ratio box) becomes `absolute inset-0 grid` with `aspect="auto"`: the parent keeps sizing
//   the box and nothing carries a min-height. An absolute iframe that does not fill, or whose parent is
//   not relative, is a refusal, and so is a padding-ratio parent (`padding-bottom: 40%`) without one;
// - an iframe that fills a parent holding only it and sized only by an aspect class (#65,
//   champsoflogging: `aspect-video`) replaces that parent: `<ConsentEmbed … aspect="16 / 9">`, inside
//   the parent's element with its other classes and attributes if it has any; the embed's own box
//   grows with the placeholder where `grid h-full` inside the aspect box clipped it on phones;
// - otherwise the classes go on the wrapper as they are and the component keeps its own aspect.
// A grid wrapper keeps the iframe's other classes (Ruling 30); a scoped rule for one of them that sets
// a `display` other than grid/none or a height that is not definite would beat `grid` or the height
// utility and collapse the loaded map, so it is a refusal.
// A filter on the iframe is carried over to ConsentEmbed's iframe with `:global(iframe)` (Rulings 19,
// 24): an inline style's `filter` goes into a new scoped rule, and a scoped <style> rule that
// targets the iframe gets a copy after it, under the wrapper, carrying only its `filter` and
// `transition` declarations. The original rule stays as it is.
// A Tailwind filter utility on the iframe (`grayscale`, `sepia`, `blur-sm`, …) goes on the wrapper as
// `[&_iframe]:<utility>`, so it filters the loaded map and not the placeholder; one with a variant
// (`hover:grayscale-0`) is a refusal.
import { type AstroNode, attr, elements } from '../lib/astro-ast'
import type { IframeInfo, Report } from '../types'
import { eolOf, type Planner, refuseNeedsHuman } from './engine'
import { indentAt, parseFile, spliceTarget, wireImport, withParents } from './markup'

const FIXED_CLASS = /^h-(?:\d+(?:\.\d+)?|\[\d+(?:\.\d+)?(?:px|rem|em|vh)\])$/
const FIXED_ATTR = /^\s*(\d+(?:\.\d+)?)(px|rem)?\s*$/
const DEFINITE = /^(?:\d+(?:\.\d+)?(?:px|rem|em|vh|svh|dvh|lvh)|clamp\(.*\))$/i
const CARRIED = new Set(['filter', 'transition'])
const FILTER_UTILITY = /^!?-?(?:blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia|filter)(?:-.+)?$/

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
  /** Inside an at-rule (`@media`, `@supports`, …): applies on some screens only. */
  media: boolean
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
          media: stack.some((b) => b.prelude.startsWith('@')),
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
export function scopedStyles(text: string, root: AstroNode): { start: number; end: number; node: AstroNode }[] {
  return elements(root, 'style')
    .filter((s) => !s.attributes.some((a) => a.name === 'is:global' || a.name === 'global'))
    .flatMap((s) => {
      const start = text.indexOf('>', s.start) + 1
      const end = text.lastIndexOf('</', s.end - 1)
      return start > 0 && end >= start ? [{ start, end, node: s }] : []
    })
}

const unimportant = (v: string): string => v.replace(/!\s*important\s*$/i, '').trim()

/** A definite length that is not zero (`height: 0` with padding is the aspect-ratio hack). */
const sized = (v: string): boolean => DEFINITE.test(v) && !/^0+(?:\.0+)?[a-z]*$/i.test(v)

/** Scoped rules for exactly one of the element's classes (`.karta`), as Ruling 25 reads them. */
export const ownRules = (el: AstroNode, rules: CssRule[]): CssRule[] => {
  const classes = classList(el) ?? []
  return rules.filter((r) => splitTop(r.selector, /,/).some((s) => classes.some((c) => s.trim() === `.${c}`)))
}

/**
 * The parent has a definite height (Ruling 25): a fixed h- class, an aspect class (#61), an inline
 * height, or a scoped CSS height or aspect-ratio for one of its classes. A min-height is not one: a percentage height against it is auto.
 */
function definiteHeight(parent: AstroNode, rules: CssRule[]): boolean {
  if (parent.type !== 'element') return false
  if ((classList(parent) ?? []).some((c) => FIXED_CLASS.test(c))) return true
  // #61 (champsoflogging): `aspect-video w-full` takes its height from its width. A variant is unsure.
  if ((classList(parent) ?? []).some((c) => ASPECT_CLASS.test(c))) return true
  const isHeight = (d: CssDecl): boolean => d.prop === 'height' && sized(unimportant(d.value))
  const style = attr(parent, 'style')
  if (style?.kind === 'quoted' && declarations(style.value).some(isHeight)) return true
  const own = ownRules(parent, rules)
  if (own.some((r) => r.decls.some(isHeight))) return true
  return ratioSized(parent, own, rules)
}

/**
 * ahatrafikskola: `.frame { aspect-ratio: 4 / 5 }`, 4 / 3 on phones. A plain ratio for one of the
 * parent's classes outside an at-rule, and nothing else that could switch it off: no rule naming
 * the class, the element or its id in any selector (`.wrap .frame`, `.frame:hover`, `div`, inside
 * an at-rule) with another aspect-ratio value or a display other than a block-level one, no display
 * class that is not one (variants and `!` included), no inline aspect-ratio or display at all, and
 * not a span. Attribute selectors (`[class~=frame]`) are not seen, as in ownRules.
 */
function ratioSized(parent: AstroNode, own: CssRule[], rules: CssRule[]): boolean {
  if (parent.type !== 'element' || parent.name === 'span') return false
  if (!own.some((r) => !r.media && r.decls.some((d) => d.prop === 'aspect-ratio' && ratio(d.value)))) return false
  const style = attr(parent, 'style')
  if (style?.kind === 'quoted' && declarations(style.value).some((d) => d.prop === 'aspect-ratio' || d.prop === 'display')) return false
  if ((classList(parent) ?? []).some(dropsBox)) return false
  return namingRules(parent, rules).every((r) =>
    r.decls.every((d) => (d.prop !== 'aspect-ratio' || ratio(d.value)) && (d.prop !== 'display' || BOX_DISPLAY.test(unimportant(d.value)))),
  )
}

/** Scoped rules that name the element's class, element name or id anywhere in a selector. */
function namingRules(el: AstroNode, rules: CssRule[]): CssRule[] {
  const esc = (x: string): string => x.replace(/[^\w-]/g, '\\$&')
  const id = attr(el, 'id')
  const names = [
    ...(classList(el) ?? []).map((c) => new RegExp(`\\.${esc(c)}(?![\\w-])`)),
    ...(el.name ? [new RegExp(`(?:^|[\\s>+~,(])${esc(el.name)}(?![\\w-])`, 'i')] : []),
    ...(id?.kind === 'quoted' ? [new RegExp(`#${esc(id.value.trim())}(?![\\w-])`)] : []),
  ]
  return rules.filter((r) => names.some((n) => n.test(r.selector)))
}

/** The utility after its variants, without Tailwind's important modifier (`!contents`, v4 `contents!`). */
const utility = (c: string): string => c.slice(c.lastIndexOf(':') + 1).replace(/^!|!$/g, '')

/** A display class (any variant, `!` included) that does not keep a block box. */
const dropsBox = (c: string): boolean => /\[display:/i.test(c) || (DISPLAY_CLASS.test(utility(c)) && !BOX_DISPLAY.test(utility(c)))

/** Tailwind's display utilities, and the display values that keep a block box with an aspect-ratio. */
const DISPLAY_CLASS = /^(?:block|inline|inline-block|flex|inline-flex|grid|inline-grid|flow-root|contents|hidden|list-item|table(?:-[a-z-]+)?|inline-table)$/
const BOX_DISPLAY = /^(?:block|flex|grid|flow-root)$/

/** A plain, non-degenerate aspect-ratio value: `4 / 3`, `16/9`, `1.5`. */
function ratio(value: string): boolean {
  const m = RATIO.exec(unimportant(value))
  return m !== null && Number(m[1]) > 0 && (m[2] === undefined || Number(m[2]) > 0)
}

const RATIO = /^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/

/** Tailwind's aspect classes without a variant: `aspect-video`, `aspect-square`, `aspect-4/3`, `aspect-[4/3]`. */
const ASPECT_CLASS = /^aspect-(?:video|square|\d+\/\d+|\[\d+(?:\.\d+)?\/\d+(?:\.\d+)?\])$/

/** The ratio an aspect class sets, as ConsentEmbed's `aspect` takes it: `aspect-video` → `16 / 9`. */
function aspectOfClass(c: string): string {
  if (c === 'aspect-video') return '16 / 9'
  if (c === 'aspect-square') return '1 / 1'
  const m = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/.exec(c)!
  return `${m[1]} / ${m[2]}`
}

const MIN_H_CLASS = /^(?:[\w-]+:)*min-h-(?:\d+(?:\.\d+)?|\[[^\]\s]+\]|screen|svh|dvh|lvh)$/

/** A definite CSS length as a Tailwind arbitrary value (spaces become `_`). */
const arbitrary = (value: string): string => `min-h-[${value.replace(/\s+/g, '_')}]`

/**
 * The min-h classes the wrapper carries from the iframe's inline min-height, else (when the parent's
 * height is not definite) from the parent: its min-h classes as written, its inline min-height, or
 * the one min-height its scoped rules outside an at-rule set (a smaller one on phones only makes the
 * parent grow around the wrapper). Rules that disagree are a refusal.
 */
function minHeightOf(node: AstroNode, parent: AstroNode, rules: CssRule[], definite: boolean): string[] | Error {
  const inline = (el: AstroNode): string | undefined => {
    const style = attr(el, 'style')
    const v = style?.kind === 'quoted' ? declarations(style.value).findLast((d) => d.prop === 'min-height')?.value : undefined
    return v !== undefined && sized(unimportant(v)) ? unimportant(v) : undefined
  }
  const own = inline(node)
  if (own !== undefined) return [arbitrary(own)]
  if (definite || parent.type !== 'element') return []
  // A zero min-h (`flex-1 min-h-0`) gives no height; one with a variant only gives it on some
  // screens: at least one plain, non-zero min-h is needed, then the variants go along.
  const classes = (classList(parent) ?? []).filter((c) => MIN_H_CLASS.test(c) && !/min-h-(?:0|\[0+(?:\.0+)?[a-z]*\])$/.test(c))
  if (classes.some((c) => !c.includes(':'))) return classes
  const style = inline(parent)
  if (style !== undefined) return [arbitrary(style)]
  const values = [
    ...new Set(ownRules(parent, rules).filter((r) => !r.media).flatMap((r) => r.decls.filter((d) => d.prop === 'min-height').map((d) => unimportant(d.value)))),
  ]
  if (values.length > 1) return new Error(`the map's parent sets different min-heights (${values.join(', ')})`)
  return values.length === 1 && sized(values[0]!) ? [arbitrary(values[0]!)] : []
}

/** `root` and the ancestors of `node` under it, outermost first: the last one is its parent. */
function ancestorsOf(root: AstroNode, node: AstroNode): AstroNode[] {
  const path: AstroNode[] = []
  const visit = (n: AstroNode): boolean => {
    for (const c of n.children) {
      if (c === node) return true
      path.push(c)
      if (visit(c)) return true
      path.pop()
    }
    return false
  }
  visit(root)
  return [root, ...path]
}

/**
 * Whether one selector (no commas) is an `iframe` rule that applies to this map (see
 * scopedIframeHeight); 'unsure' for an iframe rule wire does not follow.
 */
function iframeSelector(part: string, ancestors: AstroNode[]): boolean | 'unsure' {
  const has = (el: AstroNode, type: string | undefined, classes: string[]): boolean =>
    el.type === 'element' && (type === undefined || el.name === type) && classes.every((c) => (classList(el) ?? []).includes(c))
  const m = /^(?:(.*?)(\s*>\s*|\s+))?iframe$/s.exec(part.trim())
  // `:global(iframe)`, `iframe[src]`, `iframe:hover`: an iframe rule wire does not follow.
  if (!m) return IFRAME_WORD.test(part) ? 'unsure' : false
  const ancestor = (m[1] ?? '').trim()
  if (ancestor === '') return true
  const last = /([^\s>+~]+)$/.exec(ancestor)?.[1] ?? ''
  const compound = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(last)
  if (!compound || /[+~]/.test(ancestor)) return 'unsure'
  const classes = (compound[2]!.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1))
  const scope = (m[2] ?? '').trim() === '>' ? ancestors.slice(-1) : ancestors
  return scope.some((el) => has(el, compound[1], classes))
}

/**
 * The height a scoped rule gives the iframe (#43): rules whose last compound is a bare `iframe`, with
 * no ancestor, or with one whose last compound is classes (and an optional element name) found on
 * the parent (`>`) or on an ancestor in this file: Astro scopes every compound to the component.
 * Rules inside an at-rule set the height on some screens only and are left to verify step 5, which
 * measures phones.
 * Undefined when none sets a height; an Error when they disagree or wire cannot tell if one applies.
 */
function scopedIframeHeight(ancestors: AstroNode[], rules: CssRule[]): string | undefined | Error {
  const values: string[] = []
  for (const rule of rules) {
    const height = rule.media ? undefined : rule.decls.findLast((d) => d.prop === 'height')
    if (!height) continue
    for (const part of splitTop(rule.selector, /,/)) {
      const applies = iframeSelector(part, ancestors)
      if (applies === 'unsure') return new Error(`scoped CSS '${part.trim()}' sets an iframe height and wire cannot tell if it is this map's`)
      if (applies) values.push(unimportant(height.value))
    }
  }
  const unique = [...new Set(values)]
  if (unique.length > 1) return new Error(`scoped CSS sets the map iframe's height to different values (${unique.join(', ')})`)
  return unique[0]
}

interface Box {
  classes: string[]
  aspect: boolean
  /** An inline `aspect-ratio` to carry over as `aspect="…"` when nothing fixes the height (#61). */
  ratio?: string
  /** #65: the aspect-class parent the embed replaces; `classes` are what stays on its element. */
  replace?: AstroNode
}

const POSITION_CLASS = /^(?:static|relative|absolute|fixed|sticky)$/
const PLACED = new Set(['position', 'inset', 'top', 'left', 'width', 'height'])

/**
 * #45: where the iframe sits, as position, inset, top, left, width and height, from (weakest first)
 * its width and height attributes, its utility classes, the scoped rules outside at-rules that apply
 * to it (an `iframe` rule, as scopedIframeHeight reads them, or one for exactly one of its classes)
 * and its inline style. An Error when a position class has a variant, or a rule wire cannot follow
 * or one inside an at-rule sets a position: wire cannot tell where the map sits.
 */
function placement(node: AstroNode, ancestors: AstroNode[], rules: CssRule[], classes: string[]): Map<string, string> | Error {
  const out = new Map<string, string>()
  for (const name of ['width', 'height']) {
    const a = attr(node, name)
    if (a?.kind === 'quoted') out.set(name, a.value.trim())
  }
  for (const c of classes) {
    if (c.includes(':') && POSITION_CLASS.test(utility(c))) return new Error(`the map iframe has a position class with a variant (${c})`)
    if (POSITION_CLASS.test(c)) out.set('position', c)
    else if (c === 'inset-0') out.set('inset', '0')
    else if (c === 'top-0' || c === 'left-0') out.set(c.slice(0, -2), '0')
    else if (/^[wh]-/.test(c)) out.set(c[0] === 'w' ? 'width' : 'height', c === 'w-full' || c === 'h-full' ? '100%' : c)
  }
  const own = (classList(node) ?? []).map((c) => `.${c}`)
  for (const rule of rules) {
    const parts = splitTop(rule.selector, /,/).map((part) => (own.includes(part.trim()) ? true : iframeSelector(part, ancestors)))
    const position = rule.decls.some((d) => d.prop === 'position')
    if (position && (parts.includes('unsure') || (rule.media && parts.includes(true)))) {
      return new Error(`scoped CSS '${rule.selector}' sets an iframe position and wire cannot tell if it applies to this map`)
    }
    if (rule.media || !parts.includes(true)) continue
    for (const d of rule.decls) if (PLACED.has(d.prop)) out.set(d.prop, unimportant(d.value))
  }
  const style = attr(node, 'style')
  if (style?.kind === 'quoted') for (const d of declarations(style.value)) if (PLACED.has(d.prop)) out.set(d.prop, unimportant(d.value))
  return out
}

/** The parent is `position: relative`: its inline style, else its own scoped rules, else a class. Unsure is no. */
function relativeParent(parent: AstroNode, rules: CssRule[]): boolean {
  if (parent.type !== 'element') return false
  const style = attr(parent, 'style')
  const inline = style?.kind === 'quoted' ? declarations(style.value).findLast((d) => d.prop === 'position') : undefined
  if (inline) return unimportant(inline.value) === 'relative'
  const own = ownRules(parent, rules).filter((r) => r.decls.some((d) => d.prop === 'position'))
  if (own.some((r) => r.media)) return false
  const ruled = own.flatMap((r) => r.decls.filter((d) => d.prop === 'position')).at(-1)
  if (ruled) return unimportant(ruled.value) === 'relative'
  const classes = (classList(parent) ?? []).filter((c) => POSITION_CLASS.test(utility(c)))
  return classes.length > 0 && classes.every((c) => c === 'relative')
}

/** A padding-ratio parent (#45): a percentage padding-top or -bottom, as a class, inline or in its scoped rules. */
function paddingRatio(parent: AstroNode, rules: CssRule[]): string | undefined {
  if (parent.type !== 'element') return undefined
  const cls = (classList(parent) ?? []).find((c) => /^p[tb]-\[\d+(?:\.\d+)?%\]$/.test(utility(c)))
  if (cls) return cls
  const pct = (d: CssDecl): boolean => (d.prop === 'padding-top' || d.prop === 'padding-bottom') && /%$/.test(unimportant(d.value))
  const style = attr(parent, 'style')
  const decl = [...(style?.kind === 'quoted' ? declarations(style.value) : []), ...ownRules(parent, rules).flatMap((r) => r.decls)].find(pct)
  return decl ? `${decl.prop}: ${unimportant(decl.value)}` : undefined
}

const ZERO = /^0(?:\.0+)?(?:px|rem|em|%)?$/
/** The iframe classes a box replacing the iframe drops: its position, offsets and size. */
const PLACEMENT_CLASS = /^(?:static|relative|absolute|inset-0|inset-[xy]-0|top-0|left-0|right-0|bottom-0|(?:min-|max-)?[wh]-\S+|size-\S+)$/

/** #45: an absolutely positioned iframe that fills its relative parent, or why it is refused. */
function absoluteBox(node: AstroNode, parent: AstroNode, rules: CssRule[], classes: string[], placed: Map<string, string>, text: string): Box | Error {
  const zero = (v: string | undefined): boolean => v !== undefined && ZERO.test(v)
  const inset = placed.get('inset')
  const offsets = (inset !== undefined && inset.split(/\s+/).every(zero)) || (zero(placed.get('top')) && zero(placed.get('left')))
  // A replaced element keeps its own 300×150 under `inset: 0` unless its width and height are 100%.
  if (!offsets || placed.get('width') !== '100%' || placed.get('height') !== '100%') {
    return new Error('the map iframe is absolutely positioned but does not fill its parent')
  }
  if (!relativeParent(parent, rules)) return new Error('the map iframe fills its parent absolutely, but the parent is not position: relative')
  // Review of #67: a background map under other content. The wrapper would sit under that content
  // (Visa unclickable), and a box that takes its height from the content alone has none of its own.
  if (!onlyChild(parent, node, text)) return new Error('the map iframe fills its parent absolutely, but the parent holds more than the map')
  const limit = classes.find((c) => MIN_MAX_CLASS.test(utility(c)))
  if (limit) return new Error(`the map iframe has a min/max size class (${limit}) that the absolute wrapper does not carry`)
  return aspectParentBox(node, parent, rules, classes, text) ?? { classes: ['absolute', 'inset-0', 'grid', ...classes.filter((c) => !PLACEMENT_CLASS.test(c))], aspect: true }
}

const MIN_MAX_CLASS = /^(?:min|max)-[wh]-/

/** `node` is the parent's only content: whitespace and comments aside. */
function onlyChild(parent: AstroNode, node: AstroNode, text: string): boolean {
  return parent.children.every((c) => c === node || c.type === 'comment' || (c.type === 'text' && text.slice(c.start, c.end).trim() === ''))
}

/** Review of #67: a flex or grid parent (any variant, `!` included) would shrink the embed, whose root has no width. */
const LAYOUT_CLASS = /^(?:flex|inline-flex|grid|inline-grid|place-.+|items-.+|justify-.+)$/

const SIZE_PROP = /^(?:height|min-height|max-height|block-size|min-block-size|max-block-size|aspect-ratio|display)$/
/** What an iframe replaced with its aspect parent may carry: the embed's own iframe does the same. */
const DROPPED_IFRAME_CLASS = /^(?:w-full|h-full|border-0|block|absolute|inset-0|top-0|left-0)$/
const DROPPED_IFRAME_STYLE = new Set(['position', 'inset', 'top', 'left', 'width', 'height', 'border', 'border-width', 'border-style', 'display', 'filter'])

/**
 * #65 (champsoflogging): an iframe that fills a parent holding only it and sized only by an aspect
 * class, with nothing on the iframe that the embed would lose: the embed replaces the parent with
 * the class's ratio. Null when the parent has anything else that sizes it (another aspect, height,
 * min/max-height or display class, an inline or scoped rule for it) or the iframe has a class other
 * than its size, position, border and filter utilities, or another inline style.
 */
function aspectParentBox(node: AstroNode, parent: AstroNode, rules: CssRule[], classes: string[], text: string): Box | null {
  if (parent.type !== 'element' || parent.name === 'span') return null
  if (!onlyChild(parent, node, text)) return null
  const written = classList(parent)
  const aspects = (written ?? []).filter((c) => ASPECT_CLASS.test(c))
  if (written === null || aspects.length !== 1) return null
  const others = written.filter((c) => c !== aspects[0])
  const sizing = (c: string): boolean =>
    /^(?:aspect|h|min-h|max-h|size)-/.test(utility(c)) || LAYOUT_CLASS.test(utility(c)) || /\[(?:display|height|min-height|max-height|aspect-ratio):/i.test(c) || dropsBox(c)
  if (others.some(sizing)) return null
  const style = attr(parent, 'style')
  if (style && (style.kind !== 'quoted' || declarations(style.value).some((d) => SIZE_PROP.test(d.prop)))) return null
  if (namingRules(parent, rules).some((r) => r.decls.some((d) => SIZE_PROP.test(d.prop)))) return null
  if (classes.some((c) => !DROPPED_IFRAME_CLASS.test(c) && !c.startsWith('[&_iframe]:'))) return null
  const own = attr(node, 'style')
  if (own && (own.kind !== 'quoted' || declarations(own.value).some((d) => !DROPPED_IFRAME_STYLE.has(d.prop)))) return null
  return { classes: [...others, ...classes.filter((c) => c.startsWith('[&_iframe]:'))], aspect: false, ratio: aspectOfClass(aspects[0]!), replace: parent }
}

/** The wrapper's classes and whether the embed takes `aspect="auto"`, or the reason to refuse. */
function boxOf(node: AstroNode, ancestors: AstroNode[], rules: CssRule[], text: string): Box | Error {
  const box = sizedBox(node, ancestors, rules, text)
  if (box instanceof Error || !box.aspect) return box
  return keptClassConflict(box, rules) ?? box
}

/**
 * A grid wrapper sizes the embed with `grid` and its height utility; the classes it keeps from the
 * iframe (Ruling 30) can carry scoped rules, which are unlayered and so beat those utilities. A rule
 * for a kept class that sets a `display` other than grid or none, or a height that is not definite
 * (`auto`, a percentage other than h-full's 100%, …), collapses the loaded iframe (salviablommor:
 * `.contact-map { display: block }`, the map was 0px tall): refused. A definite height still
 * stretches the grid's embed and is wired. Pseudo-element rules and classes inside `:not()` do not
 * style the wrapper. Misses (an attribute selector, `block-size`, `max-height`, global CSS) are left
 * to verify step 4, which fails a loaded iframe under 100px.
 */
function keptClassConflict(box: Box, rules: CssRule[]): Error | null {
  // `absolute inset-0 grid` (#45) fills a box of definite height, as h-full does.
  const [height, kept] = box.classes[0] === 'absolute' ? ['h-full', box.classes.slice(3)] : [box.classes[1], box.classes.slice(2)]
  const own = kept.filter((c) => /^[\w-]+$/.test(c))
  for (const rule of rules) {
    for (const sel of splitTop(rule.selector, /,/)) {
      const compound = /([^\s>+~]+)$/.exec(sel.trim())?.[1] ?? ''
      if (compound.includes('::')) continue
      const classes = (compound.replace(/:not\([^)]*\)/g, '').match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1))
      const c = own.find((k) => classes.includes(k))
      if (!c) continue
      for (const d of rule.decls) {
        const value = d.value.replace(/!\s*important\s*$/i, '').trim()
        const lower = value.toLowerCase()
        if (d.prop === 'display' && lower !== 'grid' && lower !== 'none') {
          return new Error(`scoped CSS for the iframe's class .${c} sets display: ${value}, which beats the wrapper's grid`)
        }
        if (d.prop === 'height' && !DEFINITE.test(value) && !(height === 'h-full' && value === '100%')) {
          return new Error(`scoped CSS for the iframe's class .${c} sets height: ${value}, which beats the wrapper's ${height}`)
        }
      }
    }
  }
  return null
}

function sizedBox(node: AstroNode, ancestors: AstroNode[], rules: CssRule[], text: string): Box | Error {
  const parent = ancestors.at(-1)!
  const written = classList(node)
  if (written === null) return new Error('iframe class is an expression')
  const varied = written.find((c) => c.includes(':') && FILTER_UTILITY.test(c.slice(c.lastIndexOf(':') + 1)))
  if (varied) return new Error(`iframe has a filter class with a variant (${varied})`)
  const classes = written.map((c) => (FILTER_UTILITY.test(c) ? `[&_iframe]:${c}` : c))
  const placed = placement(node, ancestors, rules, classes)
  if (placed instanceof Error) return placed
  if (placed.get('position') === 'absolute') return absoluteBox(node, parent, rules, classes, placed, text)
  const padded = paddingRatio(parent, rules)
  if (padded) return new Error(`the map's parent is a padding-ratio box (${padded}) and the iframe does not fill it absolutely`)
  // Ruling 31: an inline style height beats the height attribute, as in CSS.
  const style = attr(node, 'style')
  const inlineHeight = style?.kind === 'quoted' ? declarations(style.value).findLast((d) => d.prop === 'height')?.value.trim() : undefined
  // #43: so does a scoped rule, which also beats a (layered) Tailwind height class.
  const ruled = inlineHeight === undefined ? scopedIframeHeight(ancestors, rules) : undefined
  if (ruled instanceof Error) return ruled
  const ruledFixed = ruled !== undefined ? /^(\d+(?:\.\d+)?)(px|rem|vh)$/i.exec(ruled) : null
  if (ruled !== undefined && ruled !== '100%' && !ruledFixed) return new Error(`scoped CSS sets the map iframe's height: ${ruled}`)
  const isHeight = (c: string): boolean => FIXED_CLASS.test(c) || c === 'h-full'
  const variantHeight = ruled !== undefined ? classes.find((c) => c.includes(':') && /^(?:h-|size-)/.test(c.slice(c.lastIndexOf(':') + 1))) : undefined
  if (variantHeight) return new Error(`iframe has a height class with a variant (${variantHeight}) that scoped CSS overrides`)
  if (ruledFixed) {
    return { classes: ['grid', `h-[${ruledFixed[1]}${ruledFixed[2]!.toLowerCase()}]`, ...classes.filter((c) => !isHeight(c))], aspect: true }
  }
  const fixed = ruled === undefined ? classes.find((c) => FIXED_CLASS.test(c)) : undefined
  if (fixed) return { classes: ['grid', fixed, ...classes.filter((c) => c !== fixed)], aspect: true }
  const inlineFixed = inlineHeight !== undefined ? /^(\d+(?:\.\d+)?)(px|rem|vh)$/i.exec(inlineHeight) : null
  if (inlineFixed) return { classes: ['grid', `h-[${inlineFixed[1]}${inlineFixed[2]!.toLowerCase()}]`, ...classes], aspect: true }
  const height = attr(node, 'height')
  const fills =
    ruled === '100%' ||
    classes.includes('h-full') ||
    inlineHeight === '100%' ||
    (inlineHeight === undefined && height?.kind === 'quoted' && height.value.trim() === '100%')
  if (fills) {
    const replaced = aspectParentBox(node, parent, rules, classes, text)
    if (replaced) return replaced
    const definite = definiteHeight(parent, rules)
    const min = minHeightOf(node, parent, rules, definite)
    if (min instanceof Error) return min
    if (!definite && min.length === 0) return new Error('map fills a parent of unknown height')
    return { classes: ['grid', 'h-full', ...min, ...classes.filter((c) => !isHeight(c))], aspect: true }
  }
  const n = inlineHeight !== undefined ? null : height?.kind === 'quoted' ? FIXED_ATTR.exec(height.value) : height?.kind === 'expression' ? /^\s*(\d+)()\s*$/.exec(height.value) : null
  if (n) return { classes: ['grid', `h-[${n[1]}${n[2] || 'px'}]`, ...classes], aspect: true }
  // #61 (exakthaltagning): `aspect-ratio: 4/3; height: auto` would otherwise get the default 16:9.
  const ratio = style?.kind === 'quoted' && (inlineHeight === undefined || inlineHeight === 'auto') ? declarations(style.value).findLast((d) => d.prop === 'aspect-ratio')?.value.trim() : undefined
  const r = ratio !== undefined ? RATIO.exec(ratio) : null
  return r ? { classes, aspect: false, ratio: r[2] ? `${r[1]} / ${r[2]}` : r[1]! } : { classes, aspect: false }
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

/**
 * #65: the aspect parent `p` as written with `embed` in place of `iframe` and `classes` as its class
 * (the attribute dropped when empty); just the embed when a bare div with no attributes would be left
 * and no filter rule needs a div around it.
 */
function replacedParent(text: string, p: AstroNode, iframe: AstroNode, classes: string[], embed: string, needsDiv: boolean): string {
  const cls = p.attributes.find((a) => a.name === 'class')!
  if (classes.length === 0 && p.attributes.length === 1 && p.name === 'div' && !needsDiv) return embed
  const before = text.slice(p.start, cls.start)
  const after = text.slice(cls.end, iframe.start)
  const head = classes.length > 0 ? `${before}class="${classes.join(' ')}"${after}` : `${before.trimEnd()}${after}`
  return `${head}${embed}${text.slice(iframe.end, p.end)}`
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
      const box = boxOf(hit.node, ancestorsOf(tree.root, hit.node), rules, text)
      if (box instanceof Error) {
        planner.refuse(file, target, box.message)
        continue
      }
      const id = attrSource(text, hit.node, 'id')
      const props = [`service="${info.service}"`, attrSource(text, hit.node, 'src')!, title, ...(box.aspect ? ['aspect="auto"'] : box.ratio ? [`aspect="${box.ratio}"`] : []), ...(id ? [id] : [])]
      const embed = `<${name} ${props.join(' ')} />`
      if (box.replace) {
        const p = box.replace
        const out = replacedParent(text, p, hit.node, box.classes, needsDiv && p.name !== 'div' ? `<div>${embed}</div>` : embed, needsDiv)
        spliceTarget(planner, target, file, () => false, () => [{ hit: { start: p.start, end: p.end }, text: out }], 'replace')
        continue
      }
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
