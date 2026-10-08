// Detects every <iframe> in the site's .astro files, how its `src` is given, and the host and
// registry service it loads; and lists map URLs whose `pb=` parameter looks made up.
//
// An expression `src` is followed back to a literal through a small evaluator over the
// frontmatter: string literals, template literals without `${}`, top-level `const`s, relative
// imports of JSON/TS data files, `===`/`!==`, `!`, `&&`/`||` and `? :`. A `src` that depends on a
// component prop is evaluated once per call site. Anything else is `unresolved`, which makes the
// site `needs-human`: the evaluator answers or gives up, it never guesses.
//
// For an unresolved `src` the host and service still matter (a Google Calendar is a third-party
// host; a home-made gate's map is still a map), so they are taken from "candidates": the literals
// the expression could produce. Candidates only describe; they never make a `src` resolved.
import ts from 'typescript'
import { matchesRegistry } from '../../../src/services'
import type { IframeInfo, SrcKind } from '../types'
import { type AstroNode, attr, parseAstro } from '../lib/astro-ast'
import { astroImports, resolveRelative } from '../lib/site-imports'
import type { SiteFiles } from '../lib/site-files'
import { importsOf, parseModule, propertyOf, topLevelConst } from '../lib/ts-ast'

export interface DetectedIframes {
  iframes: IframeInfo[]
  /** Full `src` strings of maps whose `pb=` place id or timestamp is made up (`isInventedPb`). */
  inventedMaps: string[]
  /** `.astro` files under src/ that did not parse; they are skipped. */
  parseErrors: { file: string; message: string }[]
}

/**
 * A `pb=` map URL whose place id repeats a two-character hex pair four or more times
 * (`0x465169e2e2e2e2e3`), or whose `!4v` timestamp is round (`…000000`) or `1234567890…`.
 * Real embeds copied from Google have neither.
 */
export function isInventedPb(url: string): boolean {
  if (!/[?&;]pb=/.test(url)) return false
  const id = /!1s0x([0-9a-f]+)(?:%3A|:)0x([0-9a-f]+)/i.exec(url)
  if (id && [id[1]!, id[2]!].some((hex) => /([0-9a-f]{2})\1{3,}/i.test(hex))) return true
  const stamp = /!4v(\d+)/.exec(url)?.[1]
  return stamp !== undefined && (stamp.endsWith('000000') || stamp.startsWith('1234567890'))
}

type Value =
  | { kind: 'string'; value: string; dataPath?: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'json'; value: object; dataPath: string }
  | { kind: 'object'; node: ts.ObjectLiteralExpression; scope: Scope }
  | { kind: 'props' }

/** What a call site passes for a prop: a value, nothing (the attribute is absent), or unknown (null). */
type Arg = Value | 'absent' | null

interface Scope {
  file: string
  sf: ts.SourceFile
  /** Local name → prop name and default, from `const { … } = Astro.props`. */
  props: Map<string, { prop: string; init: ts.Expression | null }>
  /** Names bound by an enclosing `{…}` expression (a `.map()` callback's parameters). */
  shadowed: Set<string>
  /** Call-site values; null when the component is evaluated on its own. */
  args: ((prop: string) => Arg) | null
  /** Set when evaluation reached a prop. */
  state: { usedProp: boolean }
}

interface Parsed {
  text: string
  root: AstroNode
  frontmatter: string
  sf: ts.SourceFile
  props: Scope['props']
}

const MAX_DEPTH = 25

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression
  }
  return e
}

const isAstroProps = (e: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Astro' && e.name.text === 'props'

/** `const { a, b: c, d = 'x' } = Astro.props` (or `let`) at the top level of the frontmatter. */
function propsOf(sf: ts.SourceFile): Scope['props'] {
  const out: Scope['props'] = new Map()
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isObjectBindingPattern(decl.name) || !isAstroProps(unwrap(decl.initializer))) continue
      for (const el of decl.name.elements) {
        if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue
        const key = el.propertyName
        const prop = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : el.name.text
        out.set(el.name.text, { prop, init: el.initializer ?? null })
      }
    }
  }
  return out
}

/** Parses the source of a `{…}` attribute value as one expression, or null. */
function parseExpression(source: string): ts.Expression | null {
  const sf = parseModule(`(${source}\n)`)
  const [stmt] = sf.statements
  return sf.statements.length === 1 && stmt && ts.isExpressionStatement(stmt) ? unwrap(stmt.expression) : null
}

/** Every name bound inside a `{…}` expression: parameters, variables, destructured names. */
function boundNames(source: string): Set<string> {
  const sf = ts.createSourceFile('expr.tsx', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const out = new Set<string>()
  const addName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) out.add(name.text)
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) addName(el.name)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isParameter(n) || ts.isVariableDeclaration(n)) addName(n.name)
    n.forEachChild(visit)
  }
  visit(sf)
  return out
}

class Evaluator {
  private readonly modules = new Map<string, { json: unknown } | { sf: ts.SourceFile } | null>()

  constructor(private readonly files: SiteFiles) {}

  evaluate(expr: ts.Expression, scope: Scope, depth = 0): Value | null {
    if (depth > MAX_DEPTH) return null
    const e = unwrap(expr)
    const next = (x: ts.Expression, s: Scope = scope): Value | null => this.evaluate(x, s, depth + 1)

    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { kind: 'string', value: e.text }
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'boolean', value: true }
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: false }
    if (ts.isObjectLiteralExpression(e)) return { kind: 'object', node: e, scope }
    if (ts.isIdentifier(e)) return this.identifier(e.text, scope, depth)

    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      if (isAstroProps(e)) return { kind: 'props' }
      let key: string | null = null
      if (ts.isPropertyAccessExpression(e)) key = e.name.text
      else {
        const arg = unwrap(e.argumentExpression)
        if (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) key = arg.text
      }
      if (key === null || e.questionDotToken) return null
      const base = next(e.expression)
      if (!base) return null
      if (base.kind === 'props') return this.prop(key, null, scope, depth)
      if (base.kind === 'json') {
        if (!Object.hasOwn(base.value, key)) return null
        return jsonValue((base.value as Record<string, unknown>)[key], base.dataPath)
      }
      if (base.kind === 'object') {
        const value = propertyOf(base.node, key)
        return value ? next(value, base.scope) : null
      }
      return null
    }

    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const v = next(e.operand)
      const t = v ? truthy(v) : null
      return t === null ? null : { kind: 'boolean', value: !t }
    }

    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        const a = next(e.left)
        const b = next(e.right)
        if (!a || !b || (a.kind !== 'string' && a.kind !== 'boolean') || (b.kind !== 'string' && b.kind !== 'boolean')) return null
        const equal = a.kind === b.kind && a.value === b.value
        const negated = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
        return { kind: 'boolean', value: negated ? !equal : equal }
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const a = next(e.left)
        const t = a ? truthy(a) : null
        if (t === null) return null
        return (op === ts.SyntaxKind.BarBarToken) === t ? a : next(e.right)
      }
      return null
    }

    if (ts.isConditionalExpression(e)) {
      const c = next(e.condition)
      const t = c ? truthy(c) : null
      if (t === null) return null
      return next(t ? e.whenTrue : e.whenFalse)
    }

    return null
  }

  private identifier(name: string, scope: Scope, depth: number): Value | null {
    if (scope.shadowed.has(name)) return null
    const prop = scope.props.get(name)
    if (prop) return this.prop(prop.prop, prop.init, scope, depth)
    const imp = importsOf(scope.sf).find(
      (i) => !i.typeOnly && (i.defaultName === name || i.named.some((n) => n.local === name)),
    )
    if (imp) {
      const imported = imp.defaultName === name ? 'default' : imp.named.find((n) => n.local === name)!.imported
      return this.imported(scope.file, imp.from, imported, depth)
    }
    const init = topLevelConst(scope.sf, name)?.initializer
    return init ? this.evaluate(init, scope, depth + 1) : null
  }

  private prop(prop: string, init: ts.Expression | null, scope: Scope, depth: number): Value | null {
    scope.state.usedProp = true
    if (!scope.args) return null
    const arg = scope.args(prop)
    if (arg !== 'absent') return arg
    return init ? this.evaluate(init, scope, depth + 1) : null
  }

  /** The value `imported` (`default` for a default import) of the relative module `from`. */
  private imported(file: string, from: string, imported: string, depth: number): Value | null {
    const path = resolveRelative(this.files, file, from)
    if (!path || path.endsWith('.astro')) return null
    const mod = this.module(path)
    if (!mod) return null
    if ('json' in mod) {
      if (imported === 'default') return jsonValue(mod.json, path)
      const json = mod.json
      if (typeof json !== 'object' || json === null || Array.isArray(json) || !Object.hasOwn(json, imported)) return null
      return jsonValue((json as Record<string, unknown>)[imported], path)
    }
    if (imported === 'default') return null
    const scope: Scope = { file: path, sf: mod.sf, props: new Map(), shadowed: new Set(), args: null, state: { usedProp: false } }
    const v = this.identifier(imported, scope, depth + 1)
    return v?.kind === 'string' ? { ...v, dataPath: v.dataPath ?? path } : v
  }

  private module(path: string): { json: unknown } | { sf: ts.SourceFile } | null {
    if (!this.modules.has(path)) {
      let mod: { json: unknown } | { sf: ts.SourceFile } | null
      try {
        const text = this.files.read(path)
        mod = path.endsWith('.json') ? { json: JSON.parse(text) as unknown } : { sf: parseModule(text) }
      } catch {
        mod = null
      }
      this.modules.set(path, mod)
    }
    return this.modules.get(path) ?? null
  }
}

function jsonValue(v: unknown, dataPath: string): Value | null {
  if (typeof v === 'string') return { kind: 'string', value: v, dataPath }
  if (typeof v === 'boolean') return { kind: 'boolean', value: v }
  if (typeof v === 'object' && v !== null) return { kind: 'json', value: v, dataPath }
  return null
}

function truthy(v: Value): boolean | null {
  if (v.kind === 'string') return v.value !== ''
  if (v.kind === 'boolean') return v.value
  return null
}

/** The host a URL loads from, and its registry service. Own-domain and relative URLs have none. */
function classify(url: string, ownDomains: string[]): { host: string | null; service: IframeInfo['service'] } {
  const own = ownDomains.map((d) => d.toLowerCase())
  const trimmed = url.trim()
  if (/^(?:https?:)?\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed)
    } catch {
      return { host: null, service: null }
    }
    const host = parsed.hostname.toLowerCase()
    if (own.some((d) => host === d || host === `www.${d}`)) return { host, service: null }
    // Matched on host + path, so a registry pattern in a query string does not count.
    return { host, service: matchesRegistry(`${host}${parsed.pathname}`) }
  }
  if (trimmed === '' || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { host: null, service: null }
  return { host: own[0] ?? null, service: null }
}

const isUrlLike = (s: string): boolean => /^(?:https?:)?\/\//i.test(s.trim())

/**
 * A src the browser loads from a host: http(s), protocol-relative or relative. `about:`, `data:`,
 * `javascript:` and an empty src are not, and their real content is set some other way.
 */
const isLoadable = (s: string): boolean => {
  const t = s.trim()
  return isUrlLike(t) || (t !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(t))
}

/** URLs written anywhere inside a piece of text (a `srcdoc`, a tag). */
const urlsIn = (text: string): string[] => text.match(/(?:https?:)?\/\/[^\s"'<>`]+/gi) ?? []

/** Attributes that load or replace the frame's content behind `src`'s back. */
const LAZY = ['srcdoc', 'data-src', 'data-lazy-src']

/** Where the text sweep looks for iframes the .astro parser does not cover. */
const SWEEP_SKIP = /\.(?:astro|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf|mp[34]|webm|ogg|wav|mov|zip|gz)$/i

/** A quoted value as written, an expression as `{…}`, a bare attribute as '', or null. */
function rawAttr(node: AstroNode, name: string): string | null {
  const a = attr(node, name)
  if (!a) return null
  return a.kind === 'expression' ? `{${a.value}}` : a.value
}

export function detectIframes(files: SiteFiles, ownDomains: string[]): DetectedIframes {
  const parseErrors: DetectedIframes['parseErrors'] = []
  const parsed = new Map<string, Parsed>()
  for (const file of files.list('src/**/*.astro')) {
    const text = files.read(file)
    try {
      const tree = parseAstro(text)
      const frontmatter = tree.frontmatter?.text ?? ''
      const sf = parseModule(frontmatter)
      parsed.set(file, { text, root: tree.root, frontmatter, sf, props: propsOf(sf) })
    } catch (e) {
      parseErrors.push({ file, message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Nodes matching `match`, each with the names enclosing `{…}` expressions bind around it. */
  const scoped = (p: Parsed, match: (n: AstroNode) => boolean): { node: AstroNode; shadowed: Set<string> }[] => {
    const out: { node: AstroNode; shadowed: Set<string> }[] = []
    const walk = (n: AstroNode, shadowed: Set<string>): void => {
      if (match(n)) out.push({ node: n, shadowed })
      let inner = shadowed
      if (n.type === 'expression' && n.children.length > 0) {
        const source = p.text.slice(n.start, n.end).replace(/^\{/, '').replace(/\}$/, '')
        inner = new Set([...shadowed, ...boundNames(source)])
      }
      for (const c of n.children) walk(c, inner)
    }
    walk(p.root, new Set())
    return out
  }

  const evaluator = new Evaluator(files)
  const scopeOf = (file: string, shadowed = new Set<string>(), args: Scope['args'] = null): Scope => {
    const p = parsed.get(file)!
    return { file, sf: p.sf, props: p.props, shadowed, args, state: { usedProp: false } }
  }

  /** Where the component `file` is rendered: each tag in a file that default-imports it by a relative path. */
  const callSitesOf = (file: string): { file: string; node: AstroNode; shadowed: Set<string> }[] => {
    const out: { file: string; node: AstroNode; shadowed: Set<string> }[] = []
    for (const [caller, p] of parsed) {
      const locals = new Set([...astroImports(caller, p.frontmatter)].flatMap(([local, target]) => (target === file ? [local] : [])))
      if (locals.size === 0) continue
      for (const use of scoped(p, (n) => n.type === 'component' && locals.has(n.name ?? ''))) out.push({ file: caller, ...use })
    }
    return out
  }

  /** The value a call site passes for `prop`, evaluated in the caller's frontmatter. */
  const argOf =
    (caller: string, node: AstroNode, shadowed: Set<string>) =>
    (prop: string): Arg => {
      const a = attr(node, prop)
      if (!a) return node.attributes.some((x) => x.kind === 'spread') ? null : 'absent'
      if (a.kind === 'quoted') return { kind: 'string', value: a.value }
      if (a.kind === 'empty') return { kind: 'boolean', value: true }
      const expr = parseExpression(a.value)
      const v = expr ? evaluator.evaluate(expr, scopeOf(caller, shadowed)) : null
      return v && (v.kind === 'string' || v.kind === 'boolean') ? v : null
    }

  /** Literals an unresolved expression could produce; see the header comment. */
  const candidatesOf = (expr: ts.Expression, scope: Scope): string[] => {
    const out = new Set<string>()
    const quiet = (): Scope => ({ ...scope, state: { usedProp: false } })
    const propertyLiterals = (name: string): void => {
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === name) {
          const init = unwrap(n.initializer)
          if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) out.add(init.text)
        }
        n.forEachChild(visit)
      }
      visit(scope.sf)
    }
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        out.add(n.text)
        return
      }
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
        const v = evaluator.evaluate(n, quiet())
        if (v?.kind === 'string') {
          out.add(v.value)
          return
        }
        if (ts.isPropertyAccessExpression(n)) {
          propertyLiterals(n.name.text)
          visit(n.expression)
        }
        return
      }
      n.forEachChild(visit)
    }
    visit(expr)
    return [...out]
  }

  /** Every URL-like string literal in a frontmatter: where a script-set `src` comes from. */
  const frontmatterUrls = (sf: ts.SourceFile): string[] => {
    const out: string[] = []
    const visit = (n: ts.Node): void => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isUrlLike(n.text)) out.push(n.text)
      n.forEachChild(visit)
    }
    visit(sf)
    return out
  }

  const isOwn = (host: string): boolean =>
    ownDomains.some((d) => host === d.toLowerCase() || host === `www.${d.toLowerCase()}`)
  type Where = { host: string | null; service: IframeInfo['service'] }
  /** The host and service every URL shares, or null when they differ. */
  const shared = (urls: string[]): Where | null => {
    const seen = urls.map((u) => classify(u, ownDomains))
    const first = seen[0]
    return first && seen.every((s) => s.host === first.host && s.service === first.service) ? first : null
  }
  /** What the URL-like candidates agree on; nothing when there are none or they differ. */
  const agreed = (candidates: string[]): Where => {
    const where = shared(candidates.filter(isUrlLike))
    // A guess must never make an unknown frame look like the site's own.
    if (!where || where.host === null || isOwn(where.host)) return { host: null, service: null }
    return where
  }

  const iframes: IframeInfo[] = []
  const invented: string[] = []
  const note = (urls: (string | null)[]): void => {
    for (const u of urls) if (u !== null && isInventedPb(u) && !invented.includes(u)) invented.push(u)
  }

  // `files.list` is sorted, so files come in path order and iframes in document order.
  for (const [file, p] of parsed) {
    for (const { node, shadowed } of scoped(p, (n) => n.type === 'element' && n.name === 'iframe')) {
      const base = {
        file,
        start: node.start,
        end: node.end,
        title: rawAttr(node, 'title'),
        classes: rawAttr(node, 'class'),
        height: rawAttr(node, 'height'),
        style: rawAttr(node, 'style'),
      }
      const unresolved = (candidates: string[]): IframeInfo => {
        note(candidates)
        return { ...base, srcKind: 'unresolved', src: null, ...agreed(candidates) }
      }
      const src = attr(node, 'src')

      const lazy = LAZY.flatMap((name) => {
        const a = attr(node, name)
        if (!a) return []
        if (a.kind !== 'expression') return [a.value, ...urlsIn(a.value)]
        const expr = parseExpression(a.value)
        return expr ? candidatesOf(expr, scopeOf(file, shadowed)) : []
      })
      if (LAZY.some((name) => attr(node, name) !== null) || node.attributes.some((a) => a.kind === 'spread')) {
        iframes.push(unresolved([...lazy, ...(src?.kind === 'quoted' ? [src.value] : [])]))
        continue
      }
      if (!src || src.kind === 'empty') {
        iframes.push(unresolved(frontmatterUrls(p.sf)))
        continue
      }
      if (src.kind === 'quoted') {
        if (!isLoadable(src.value)) {
          iframes.push(unresolved([]))
          continue
        }
        note([src.value])
        iframes.push({ ...base, srcKind: 'literal', src: src.value, ...classify(src.value, ownDomains) })
        continue
      }

      const expr = parseExpression(src.value)
      if (!expr) {
        iframes.push(unresolved([]))
        continue
      }
      const scope = scopeOf(file, shadowed)
      const value = evaluator.evaluate(expr, scope)
      if (value?.kind === 'string' && !isLoadable(value.value)) {
        iframes.push(unresolved([]))
        continue
      }
      if (value?.kind === 'string') {
        note([value.value])
        const srcKind: SrcKind = value.dataPath ? 'data-file' : 'expression'
        iframes.push({
          ...base,
          srcKind,
          src: value.value,
          ...(value.dataPath ? { dataPath: value.dataPath } : {}),
          ...classify(value.value, ownDomains),
        })
        continue
      }
      if (!scope.state.usedProp) {
        iframes.push(unresolved(candidatesOf(expr, scope)))
        continue
      }

      // The src depends on a prop: evaluate it once per call site.
      const callSites = callSitesOf(file).map((use) => {
        const v = evaluator.evaluate(expr, scopeOf(file, shadowed, argOf(use.file, use.node, use.shadowed)))
        return { file: use.file, src: v?.kind === 'string' ? v.value : null }
      })
      const resolved = callSites.flatMap((c) => (c.src === null ? [] : [c.src]))
      note(resolved)
      const complete = callSites.length > 0 && resolved.length === callSites.length && resolved.every(isLoadable)
      const where = complete ? shared(resolved) : null
      // Call sites that disagree on host or service are as unknown as an unresolved src: fail closed.
      iframes.push(
        where
          ? { ...base, srcKind: 'expression', src: null, callSites, ...where }
          : { ...base, srcKind: 'unresolved', src: null, callSites, ...agreed(resolved) },
      )
    }
  }

  // A cheap sweep over every other text file: Markdown/MDX, JSX/TSX, Vue, Svelte, public HTML.
  // These iframes are only reported (unresolved, so the site goes to a human), never wired.
  for (const file of [...files.list('src/**'), ...files.list('public/**')].sort()) {
    if (SWEEP_SKIP.test(file)) continue
    let text: string
    try {
      text = files.read(file)
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    for (const m of text.matchAll(/<iframe\b/gi)) {
      const start = m.index
      const close = text.indexOf('>', start)
      const end = close < 0 ? start + '<iframe'.length : close + 1
      const candidates = urlsIn(text.slice(start, end))
      note(candidates)
      iframes.push({
        file,
        start,
        end,
        srcKind: 'unresolved',
        src: null,
        ...agreed(candidates),
        title: null,
        classes: null,
        height: null,
        style: null,
      })
    }
  }

  return { iframes, inventedMaps: invented, parseErrors }
}
