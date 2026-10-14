// Detects Elfsight widgets: the platform script and the `elfsight-app-<uuid>` divs it fills, paired
// by file. Only the forms the pool survey found are recognised; everything else is a reason naming
// the file, so the site goes to a human.
//
// Every Elfsight occurrence must be accounted for, not just every file: after the widgets are read,
// the raw text of every source file is swept, and any occurrence outside a recognised widget (or an
// already wired package <ConsentWidget>) is a reason. Only `.astro` HTML comments and CSP header
// lines in public/_headers are left out; nothing is stripped anywhere else.
import { type ServiceSlug, SERVICE_SLUGS } from '../../../src/services'
import { type AstroNode, attr, parseAstro } from '../lib/astro-ast'
import { astroImports } from '../lib/site-imports'
import { importsOf, parseModule } from '../lib/ts-ast'
import type { SiteFiles } from '../lib/site-files'
import type { Report, WidgetInfo } from '../types'
import { BINARY, packageDeps } from './scripts'

export interface DetectedWidgets {
  widgets: WidgetInfo[]
  /** Services of package <ConsentWidget> elements already in the source. */
  wired: ServiceSlug[]
  reasons: string[]
  /** `.astro` files under src/ that did not parse; their text is swept whole. */
  parseErrors: { file: string; message: string }[]
}

/** The loader URLs a recognised script may have, as written. Both render (Task 0 probe, 2026-10-14). */
export const LOADERS = new Set(['https://elfsightcdn.com/platform.js', 'https://static.elfsight.com/platform/platform.js'])

/** Host occurrences. */
const ELFSIGHT = /elfsight(?:cdn)?\.com/i
/** Widget class occurrences. */
const APP = /elfsight-app-/
const DIV_CLASS = /^elfsight-app-[0-9a-f-]{36}$/
const SCRIPT_ATTRIBUTES = new Set(['src', 'async', 'is:inline'])
const DIV_ATTRIBUTES = new Set(['class', 'data-elfsight-app-lazy'])

const WIDGET_COMPONENT = '@visionmediahq/astro-consent/components/ConsentWidget.astro'

/** A Content-Security-Policy header line in public/_headers: it names hosts, it loads nothing. */
const CSP_LINE = /^\s*Content-Security-Policy(?:-Report-Only)?\s*:/i

type Span = { start: number; end: number }

/**
 * A comment a browser closes where the parser does: not `<!-->` or `<!--->` (closed at once) and no
 * `--!>` inside (also a close). Any other comment is swept like markup.
 */
const isPlainComment = (raw: string): boolean => /^<!--(?!-?>)[\s\S]*-->$/.test(raw) && !raw.includes('--!>')

interface Found {
  node: AstroNode
  inExpression: boolean
}

interface ParsedAstro {
  text: string
  frontmatter: string
  root: AstroNode
}

const inside = (spans: Span[], at: number): boolean => spans.some((s) => at >= s.start && at < s.end)

/** What a node is, for a reason: `<p>`, `text`, `a comment`. */
function kindOf(node: AstroNode): string {
  if (node.type === 'element' || node.type === 'component') return `<${node.name}>`
  if (node.type === 'fragment') return '<>'
  if (node.type === 'text') return 'text'
  if (node.type === 'expression') return 'an expression'
  if (node.type === 'comment') return 'a comment'
  return node.type
}

/** Problems with an Elfsight `<script src>`; none means recognised. */
function scriptProblems(found: Found): string[] {
  const { node, inExpression } = found
  const out: string[] = []
  const src = attr(node, 'src')!
  if (src.kind !== 'quoted') out.push('elfsight script src is not a literal')
  else if (!LOADERS.has(src.value)) out.push(`loader ${src.value} not recognised`)
  for (const a of node.attributes) {
    if (a.kind === 'spread') out.push(`script attribute {...${a.value}} not understood`)
    else if (!SCRIPT_ATTRIBUTES.has(a.name)) out.push(`script attribute ${a.name} not understood`)
  }
  if (inExpression) out.push('elfsight script inside an expression')
  return out
}

/** Problems with an element whose class names `elfsight-app-`; none means recognised. */
function divProblems(found: Found, text: string): string[] {
  const { node, inExpression } = found
  const out: string[] = []
  if (node.name !== 'div') out.push(`widget div is <${node.name}>`)
  const cls = attr(node, 'class')!
  if (cls.kind !== 'quoted') out.push('widget div class is not a literal')
  else {
    const tokens = cls.value.split(/\s+/).filter(Boolean)
    if (tokens.length !== 1 || !DIV_CLASS.test(tokens[0]!)) out.push(`widget div has class ${cls.value}`)
  }
  for (const a of node.attributes) {
    if (a.kind === 'spread') out.push(`widget div has {...${a.value}}`)
    else if (!DIV_ATTRIBUTES.has(a.name)) out.push(`widget div has attribute ${a.name}`)
  }
  for (const child of node.children) {
    if (child.type === 'text' && text.slice(child.start, child.end).trim() === '') continue
    out.push(`widget div has ${kindOf(child)}`)
  }
  if (inExpression) out.push('widget div inside an expression')
  return out
}

/** Sweeps `text` for Elfsight occurrences outside `skip`; true when one is found. */
function strayOccurrence(text: string, skip: Span[]): boolean {
  for (const re of [new RegExp(ELFSIGHT, 'gi'), new RegExp(APP, 'g')]) {
    for (const m of text.matchAll(re)) if (!inside(skip, m.index)) return true
  }
  return false
}

/** Spans of public/_headers lines that set a Content-Security-Policy. */
function cspLines(text: string): Span[] {
  const out: Span[] = []
  let start = 0
  for (const line of text.split('\n')) {
    if (CSP_LINE.test(line)) out.push({ start, end: start + line.length })
    start += line.length + 1
  }
  return out
}

export function detectWidgets(files: SiteFiles, layouts: Report['layouts']): DetectedWidgets {
  const widgets: WidgetInfo[] = []
  const wired = new Set<ServiceSlug>()
  const reasons: string[] = []
  const parseErrors: DetectedWidgets['parseErrors'] = []
  const add = (r: string): void => {
    if (!reasons.includes(r)) reasons.push(r)
  }

  for (const dep of packageDeps(files)) if (/elfsight/i.test(dep)) add(`elfsight: package ${dep}`)
  const config = files.list('astro.config.*')[0]
  if (config) {
    for (const imp of importsOf(parseModule(files.read(config)))) if (/elfsight/i.test(imp.from)) add(`elfsight: import ${imp.from} in ${config}`)
  }

  const parsed = new Map<string, ParsedAstro>()
  for (const file of files.list('src/**/*.astro')) {
    const text = files.read(file)
    try {
      const tree = parseAstro(text)
      parsed.set(file, { text, frontmatter: tree.frontmatter?.text ?? '', root: tree.root })
    } catch (e) {
      parseErrors.push({ file, message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Page files that render `file`: itself, a layout's pages, or (one level) its importers mapped the same way. */
  const layoutPages = (file: string): string[] | null => layouts.find((l) => l.file === file)?.pages ?? null
  const direct = (file: string): string[] | null => (file.startsWith('src/pages/') ? [file] : layoutPages(file))
  const pagesOf = (file: string): string[] => {
    const own = direct(file)
    if (own !== null) return [...own]
    const out = new Set<string>()
    for (const [caller, p] of parsed) {
      if (![...astroImports(caller, p.frontmatter).values()].includes(file)) continue
      for (const page of direct(caller) ?? []) out.add(page)
    }
    return [...out].sort()
  }

  /** Spans in each `.astro` file whose Elfsight occurrences are accounted for. */
  const skipped = new Map<string, Span[]>()

  for (const [file, p] of parsed) {
    const skip: Span[] = []
    skipped.set(file, skip)
    const reason = (r: string): void => add(`elfsight: ${file}: ${r}`)

    // Local names of the package <ConsentWidget> (a default import, as the build-time scan reads it).
    const widgetNames = new Set<string>()
    for (const imp of p.frontmatter ? importsOf(parseModule(p.frontmatter)) : []) {
      if (/elfsight/i.test(imp.from)) add(`elfsight: import ${imp.from} in ${file}`)
      if (imp.from === WIDGET_COMPONENT && imp.defaultName && !imp.typeOnly) widgetNames.add(imp.defaultName)
    }

    const scripts: Found[] = []
    const divs: Found[] = []
    const walk = (n: AstroNode, inExpression: boolean): void => {
      if (n.type === 'comment') {
        // Only a comment the browser also reads to its `-->` hides what is inside it.
        if (isPlainComment(p.text.slice(n.start, n.end))) skip.push(n)
        return
      }
      if (n.type === 'component' && widgetNames.has(n.name ?? '')) {
        const service = attr(n, 'service')
        if (service?.kind === 'quoted' && (SERVICE_SLUGS as string[]).includes(service.value)) {
          wired.add(service.value as ServiceSlug)
          skip.push(n)
          return
        }
      }
      if (n.type === 'element') {
        const src = attr(n, 'src')
        if (n.name === 'script' && src && ELFSIGHT.test(src.value)) scripts.push({ node: n, inExpression })
        const cls = attr(n, 'class')
        if (cls && APP.test(cls.value)) divs.push({ node: n, inExpression })
      }
      const deeper = inExpression || n.type === 'expression'
      for (const c of n.children) walk(c, deeper)
    }
    walk(p.root, false)

    if (scripts.length === 0 && divs.length === 0) continue
    const problems: string[] = []
    if (scripts.length > 1) problems.push(`${scripts.length === 2 ? 'two' : scripts.length} elfsight scripts`)
    if (scripts.length > 0 && divs.length === 0) problems.push('elfsight script with no widget div')
    if (divs.length > 0 && scripts.length === 0) problems.push('widget div with no elfsight script')
    for (const s of scripts) problems.push(...scriptProblems(s))
    for (const d of divs) problems.push(...divProblems(d, p.text))
    if (problems.length > 0) {
      problems.forEach(reason)
      continue
    }

    const script = scripts[0]!.node
    const srcAttribute = script.attributes.find((a) => a.name === 'src')!
    skip.push(srcAttribute)
    const pages = pagesOf(file)
    for (const { node } of divs) {
      skip.push(node)
      widgets.push({
        file,
        start: node.start,
        end: node.end,
        service: 'elfsight',
        script: attr(script, 'src')!.value,
        scriptAt: { start: script.start, end: script.end },
        pages,
      })
    }
  }

  const swept = [...new Set([...files.list('src/**'), ...files.list('public/**'), ...files.list('astro.config.*')])]
    .filter((f) => !BINARY.test(f))
    .sort()
  for (const file of swept) {
    const text = files.read(file)
    const skip = skipped.get(file) ?? (file === 'public/_headers' ? cspLines(text) : [])
    if (strayOccurrence(text, skip)) add(`elfsight: ${file}: elfsight outside a recognised widget`)
  }

  return { widgets, wired: [...wired].sort(), reasons, parseErrors }
}
