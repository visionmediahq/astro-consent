// Detects the site's structure: layouts and the pages that use them, the footers a visitor sees,
// the pages that render no footer, and the privacy page's route.
//
// Everything follows render edges: a component tag in a file whose name is a default import of a
// relative `.astro` path. Imports that are not relative (aliases, packages) are not followed, so a
// page reached only through them looks footerless or layout-less: the safe direction, since that
// adds links or asks a human rather than hides a page.
import { posix } from 'node:path'
import ts from 'typescript'
import type { FooterInfo, Report } from '../types'
import { type AstroNode, attr, parseAstro } from '../lib/astro-ast'
import { parseModule } from '../lib/ts-ast'
import { astroImports } from '../lib/site-imports'
import type { SiteFiles } from '../lib/site-files'

export type DetectedStructure = Pick<Report, 'layouts' | 'footers' | 'footerless' | 'policyPage'> & {
  /** `.astro` files under src/ that did not parse; they are skipped everywhere else. */
  parseErrors: { file: string; message: string }[]
  /**
   * Pages that render more than one client footer (each use of a component counted), where wire
   * cannot place PrivacyLinks exactly once.
   */
  multiFooterPages: { page: string; footers: number }[]
  /**
   * Ruling 39: visitor pages that render their own <html> outside every layout, so wire cannot put
   * the banner on them. The 404 and 500 pages, CMS admin shells and redirect-only pages are left out.
   */
  ownHtmlPages: string[]
}

interface Parsed {
  root: AstroNode
  frontmatter: string
  /** Component tags in document order, with the file each resolves to (null when not followed). */
  uses: { name: string; start: number; target: string | null }[]
}

/**
 * Vision Media's branding strip, on every client site. Not the client's footer: the pilot never
 * put PrivacyLinks in it, and a page whose only footer is this strip counts as footerless. It is
 * still where the layout's footer area starts, so it can be a layout's footerRef.
 */
const isBranding = (file: string): boolean => posix.basename(file) === 'VisionFooter.astro'

/** A <footer> inside these belongs to that content (a quote, a card), not to the page. */
const SECTIONING = new Set(['article', 'aside', 'blockquote', 'figure', 'nav', 'section'])

const POLICY = /^(?:integritet|privacy|cookie|personuppgift|gdpr|dataskydd)/i
const leafOf = (route: string): string => route.split('/').pop() ?? ''

/** A later word of the slug is a policy word: `integritet…`, `personuppgift…`, `dataskydd…`, or exactly `gdpr`/`privacy`. */
const POLICY_INSIDE = (leaf: string): boolean =>
  leaf.split('-').some((w) => /^(?:integritet|personuppgift|dataskydd)/i.test(w) || /^(?:gdpr|privacy)$/i.test(w))

/**
 * A route under another language's folder (`/en/`, `/de-at/`…); Swedish folders such as `/om/` are
 * not one, nor `/sv(-se)/`. Nor `/it/` (#65): Swedish IT firms use it as a folder, and an Italian
 * version of a Swedish client site is rarer than that. Treating it as foreign only demoted the
 * route, so leaving it out at worst lets an Italian page tie with a Swedish one at the same depth.
 */
const FOREIGN_PREFIX = /^\/(?:en|de|fi|no|nb|nn|da|is|fr|es|nl|pl|pt|ru|uk|et|lv|lt|ar|tr|zh|ja|ko)(?:-[a-z]{2})?\//i

const isPage = (file: string): boolean => file.startsWith('src/pages/')

/** Loads a CMS admin app: Decap (`decap-cms`, `decap-cms-app`) or Sveltia (`@sveltia/cms`, `sveltia-cms.js`). */
const LOADS_CMS = /\bdecap-cms\b|\bsveltia\b/i

/**
 * A CMS admin shell (Ruling 26): a page under src/pages/admin/, or one whose frontmatter or template
 * loads Decap or Sveltia. Not a visitor page, so it never gets PrivacyLinks.
 */
const isCmsAdmin = (file: string, text: string): boolean => file.startsWith('src/pages/admin/') || LOADS_CMS.test(text)

/** Astro ignores files and folders under src/pages whose name starts with `_`. */
export const isRoute = (file: string): boolean => !file.slice('src/pages/'.length).split('/').some((s) => s.startsWith('_'))

export function routeOf(file: string): string {
  const path = file.slice('src/pages'.length).replace(/\.(?:astro|mdx?)$/, '')
  const route = path.replace(/(?:^|\/)index$/, '')
  return route === '' ? '/' : route
}

function pageFooters(root: AstroNode): AstroNode[] {
  const out: AstroNode[] = []
  const visit = (n: AstroNode): void => {
    if (n.type === 'element' && n.name === 'footer') {
      out.push(n)
      return
    }
    if (n.type === 'element' && SECTIONING.has(n.name ?? '')) return
    n.children.forEach(visit)
  }
  visit(root)
  return out
}

function componentUses(root: AstroNode): AstroNode[] {
  const out: AstroNode[] = []
  const visit = (n: AstroNode): void => {
    if (n.type === 'component') out.push(n)
    n.children.forEach(visit)
  }
  visit(root)
  return out
}

/**
 * A top-level `return` in the frontmatter: `Astro.redirect(…)`, or a bare `new Response(…)` such as
 * an SSR catch-all that hands unmatched paths to the 404 page. Astro then never renders the
 * template, so there is no page for a visitor to see. A `return` inside an `if` does not count.
 */
function frontmatterReturns(frontmatter: string): boolean {
  if (!frontmatter.includes('return')) return false
  return parseModule(frontmatter).statements.some((s) => ts.isReturnStatement(s) && s.expression !== undefined)
}

const REFRESH_ONLY = new Set(['html', 'head', 'body', 'meta', 'title', 'link', 'script'])

/** The template is a meta refresh and nothing a visitor would see. */
function metaRefreshOnly(root: AstroNode, text: string): boolean {
  let refresh = false
  const visit = (n: AstroNode, inTitle: boolean): boolean => {
    switch (n.type) {
      case 'root':
        return n.children.every((c) => visit(c, false))
      case 'comment':
      case 'doctype':
        return true
      case 'text':
        return inTitle || text.slice(n.start, n.end).trim() === ''
      case 'element': {
        if (!REFRESH_ONLY.has(n.name ?? '')) return false
        if (n.name === 'meta' && attr(n, 'http-equiv')?.value.toLowerCase() === 'refresh') refresh = true
        return n.children.every((c) => visit(c, n.name === 'title'))
      }
      default:
        return false
    }
  }
  return visit(root, false) && refresh
}

const classesOf = (n: AstroNode): string[] => {
  const cls = attr(n, 'class')
  return cls?.kind === 'quoted' ? cls.value.split(/\s+/).filter(Boolean) : []
}

const CENTRING = ['text-center', 'justify-center']
/** Left alignment on any element of the chain (inherited or explicit); justify-between only splits a row. */
const START = ['justify-start', 'text-left']

/**
 * How the end of the footer, where PrivacyLinks goes, is aligned. Follows the last element child
 * from the <footer> down: 'left' at the first `text-left`/`justify-start`, or a `justify-between`
 * row with more than one element child (Ruling 27); 'centred' at the first `text-center` or
 * `justify-center`; 'unknown' when the chain ends (no element child, or a component whose markup
 * is elsewhere) without either. `items-center` is not counted: on the pilot footers it sits on
 * rows that are also `justify-between`.
 */
function chainAlignment(footer: AstroNode): FooterInfo['alignment'] {
  let node = footer
  for (;;) {
    const classes = classesOf(node)
    const kids = node.children.filter((c) => c.type === 'element' || c.type === 'component')
    // Checked first: on a flex row, justify-start packs the items left whatever text-center says.
    if (START.some((c) => classes.includes(c))) return 'left'
    if (kids.length > 1 && classes.includes('justify-between')) return 'left'
    if (CENTRING.some((c) => classes.includes(c))) return 'centred'
    const last = kids[kids.length - 1]
    if (!last || last.type !== 'element') return 'unknown'
    node = last
  }
}

function textClassOf(classes: string[]): string | null {
  const NOT_COLOUR =
    /^text-(?:left|center|right|justify|start|end|xs|sm|base|lg|xl|\dxl|wrap|nowrap|balance|pretty|ellipsis|clip|\[\d.*\]|\[(?:length|size):.*\])$/
  return classes.find((c) => c.startsWith('text-') && !NOT_COLOUR.test(c)) ?? null
}

export function detectStructure(files: SiteFiles): DetectedStructure {
  const parseErrors: DetectedStructure['parseErrors'] = []
  const parsed = new Map<string, Parsed>()
  const texts = new Map<string, string>()

  for (const file of files.list('src/**/*.astro')) {
    const text = files.read(file)
    texts.set(file, text)
    let tree
    try {
      tree = parseAstro(text)
    } catch (e) {
      parseErrors.push({ file, message: e instanceof Error ? e.message : String(e) })
      continue
    }
    const frontmatter = tree.frontmatter?.text ?? ''
    const imports = astroImports(file, frontmatter)
    const uses = componentUses(tree.root).map((n) => {
      const target = imports.get(n.name ?? '') ?? null
      return { name: n.name ?? '', start: n.start, target: target !== null && files.exists(target) ? target : null }
    })
    parsed.set(file, { root: tree.root, frontmatter, uses })
  }

  /** Every parsed file `file` renders, itself included. */
  const closure = (file: string): Set<string> => {
    const seen = new Set<string>()
    const visit = (f: string): void => {
      if (seen.has(f) || !parsed.has(f)) return
      seen.add(f)
      for (const u of parsed.get(f)!.uses) if (u.target) visit(u.target)
    }
    visit(file)
    return seen
  }

  const footersIn = (file: string): AstroNode[] => (isBranding(file) ? [] : pageFooters(parsed.get(file)!.root))
  const anyFooterIn = (file: string): boolean => parsed.has(file) && pageFooters(parsed.get(file)!.root).length > 0

  const pages = [...parsed.keys()].filter((f) => isPage(f) && isRoute(f))
  const closures = new Map(pages.map((p) => [p, closure(p)]))

  const hasTag = (file: string, tag: string): boolean => {
    const visit = (n: AstroNode): boolean => (n.type === 'element' && n.name === tag) || n.children.some(visit)
    return visit(parsed.get(file)!.root)
  }
  const layoutFiles = [...parsed.keys()].filter((f) => !isPage(f) && (hasTag(f, 'html') || hasTag(f, 'body')))

  const layouts: Report['layouts'] = layoutFiles.map((file) => {
    const ref = parsed.get(file)!.uses.find(
      (u) => u.target !== null && (/footer/i.test(posix.basename(u.target)) || [...closure(u.target)].some(anyFooterIn)),
    )
    return {
      file,
      pages: pages.filter((p) => closures.get(p)!.has(file)),
      footerRef: ref && footersIn(file).length === 0 ? { name: ref.name, start: ref.start } : null,
    }
  })

  const layoutSet = new Set(layoutFiles)
  const rendered = new Set(pages.flatMap((p) => [...closures.get(p)!]))
  const footers: FooterInfo[] = [...rendered].sort().flatMap((file) =>
    footersIn(file).map((n): FooterInfo => {
      const classes = classesOf(n)
      const alignment = chainAlignment(n)
      return {
        file,
        start: n.start,
        end: n.end,
        kind: isPage(file) ? 'page' : layoutSet.has(file) ? 'layout' : 'component',
        textClass: textClassOf(classes),
        alignment,
        centred: alignment === 'centred',
      }
    }),
  )

  const footerless = pages.filter((p) => {
    const { root, frontmatter } = parsed.get(p)!
    if (isCmsAdmin(p, texts.get(p)!)) return false
    if (frontmatterReturns(frontmatter) || metaRefreshOnly(root, texts.get(p)!)) return false
    return ![...closures.get(p)!].some((f) => footersIn(f).length > 0)
  })

  const ownHtmlPages = pages.filter((p) => {
    const { root, frontmatter } = parsed.get(p)!
    if (!hasTag(p, 'html') || /^\/(?:404|500)$/.test(routeOf(p))) return false
    if (isCmsAdmin(p, texts.get(p)!) || frontmatterReturns(frontmatter) || metaRefreshOnly(root, texts.get(p)!)) return false
    return ![...closures.get(p)!].some((f) => layoutFiles.includes(f))
  })

  /** Client footers `file` renders, counting each use of a component. A cycle counts nothing. */
  const footerCount = (file: string, stack: Set<string> = new Set()): number => {
    if (stack.has(file) || !parsed.has(file)) return 0
    const inner = new Set([...stack, file])
    return footersIn(file).length + parsed.get(file)!.uses.reduce((n, u) => n + (u.target ? footerCount(u.target, inner) : 0), 0)
  }
  const multiFooterPages = pages.flatMap((page) => {
    const footers = footerCount(page)
    return footers > 1 ? [{ page, footers }] : []
  })

  // #61 (site 1369693991): the glob order put `/en/gdpr` before `/gdpr`. A route under another language's
  // prefix (`/en/`, `/de/`…) comes last; then a cookie page or a slug with the word only later on
  // (#65: `/om-oss/integritetspolicy` beats `/cookies`); then fewer segments, the word, the shorter path.
  const foreign = (route: string): number => (FOREIGN_PREFIX.test(route) ? 1 : 0)
  const depth = (route: string): number => route.split('/').length
  // A Swedish privacy word first, then gdpr, then English, then a cookie page, then a slug that only
  // has the word later on (site 1280190874: kopvillkor-och-integritetspolicy-gdpr).
  const rank = (route: string): number => {
    const leaf = leafOf(route)
    if (!POLICY.test(leaf)) return 4
    const i = [/^(?:integritet|personuppgift|dataskydd)/i, /^gdpr/i, /^privacy/i].findIndex((r) => r.test(leaf))
    return i === -1 ? 3 : i
  }
  const secondary = (route: string): number => (rank(route) >= 3 ? 1 : 0)
  const policy = files
    .list('src/pages/**/*.{astro,md,mdx}')
    .filter((f) => isRoute(f) && !/\[/.test(f))
    .map(routeOf)
    .filter((route) => POLICY.test(leafOf(route)) || POLICY_INSIDE(leafOf(route)))
    .sort((a, b) => foreign(a) - foreign(b) || secondary(a) - secondary(b) || depth(a) - depth(b) || rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))[0]

  return { layouts, footers, footerless, policyPage: policy ?? null, parseErrors, multiFooterPages, ownHtmlPages }
}
