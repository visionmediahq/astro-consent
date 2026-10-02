// Pure helpers for the build-time check that every <ConsentEmbed> names a service listed in privacy.json.
//
// The scan has two ways to be wrong, and they are not equal:
//   - Missing a real embed is acceptable: ConsentEmbed.astro checks its own `service` when it renders,
//     so nothing loads without consent either way.
//   - Failing the build on valid code is not: it blocks a technician on a site that is fine.
// So this reader skips whenever it is unsure. It is not an Astro parser and does not try to be one.

const DEFAULT_IMPORT = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g
/** A module specifier whose file is exactly ConsentEmbed.astro (not e.g. MapConsentEmbed.astro). */
const EMBED_FILE = /(?:^|\/)ConsentEmbed\.astro$/
const FRONTMATTER = /^\uFEFF?\s*---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/
const FENCE_LINE = /^---[ \t]*\r?$/m
const TAG_NAME = /[A-Za-z_$][\w.$:-]*/y
/** Elements whose content is text, not markup. Lowercase only: <SCRIPT> is a component to Astro. */
const RAW_TEXT = new Set(['script', 'style', 'textarea'])

/**
 * Splits an .astro source into its frontmatter and its template. Returns null when the file has a
 * `---` fence the frontmatter pattern cannot place (e.g. something precedes it): scanning code as
 * if it were markup could report an embed that does not exist.
 */
function splitAstro(source: string): { frontmatter: string; template: string } | null {
  const match = source.match(FRONTMATTER)
  if (match) return { frontmatter: match[1] ?? '', template: source.slice(match[0].length) }
  return FENCE_LINE.test(source) ? null : { frontmatter: '', template: source }
}

/** Removes block comments and whole-line `//` comments from frontmatter code. Linear. */
function stripJsComments(code: string): string {
  let result = ''
  let i = 0
  while (i < code.length) {
    const open = code.indexOf('/*', i)
    if (open < 0) break
    const close = code.indexOf('*/', open + 2)
    if (close < 0) break
    result += code.slice(i, open)
    i = close + 2
  }
  return (result + code.slice(i)).replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * Names the file uses for the embed component: every default import of ConsentEmbed.astro, plus the
 * name `ConsentEmbed` itself (it may arrive through a barrel file) unless the file imports that
 * name from some other component. Commented-out imports do not count.
 */
function embedNames(frontmatter: string): Set<string> {
  const names = new Set<string>()
  let defaultNameIsSomethingElse = false
  for (const [, name, specifier] of stripJsComments(frontmatter).matchAll(DEFAULT_IMPORT)) {
    if (EMBED_FILE.test(specifier!)) names.add(name!)
    else if (name === 'ConsentEmbed') defaultNameIsSomethingElse = true
  }
  if (!defaultNameIsSomethingElse) names.add('ConsentEmbed')
  return names
}

const isQuote = (char: string | undefined): boolean => char === '"' || char === "'" || char === '`'

/** Index just past the JS string that opens at `start`, or -1 when it never closes. */
function jsStringEnd(source: string, start: number): number {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') i += 2
    else if (source[i] === quote) return i + 1
    else i++
  }
  return -1
}

/**
 * Index just past the JS comment that opens at `start`, -1 when a block comment never closes, or
 * `start` itself when there is no comment there.
 */
function jsCommentEnd(source: string, start: number): number {
  if (source[start] !== '/') return start
  if (source[start + 1] === '*') {
    const close = source.indexOf('*/', start + 2)
    return close < 0 ? -1 : close + 2
  }
  if (source[start + 1] === '/') {
    const newline = source.indexOf('\n', start)
    return newline < 0 ? source.length : newline
  }
  return start
}

/**
 * Index just past the `{…}` expression that opens at `start`, honouring nested braces, strings and
 * comments. Returns the end of the source when the expression never closes.
 */
function skipExpression(source: string, start: number): number {
  let depth = 0
  let i = start
  while (i < source.length) {
    const char = source[i]
    if (isQuote(char)) {
      const end = jsStringEnd(source, i)
      if (end < 0) return source.length
      i = end
      continue
    }
    const afterComment = jsCommentEnd(source, i)
    if (afterComment < 0) return source.length
    if (afterComment > i) {
      i = afterComment
      continue
    }
    if (char === '{') depth++
    if (char === '}' && --depth === 0) return i + 1
    i++
  }
  return source.length
}

interface Tag {
  /** Literal values as strings; expressions, template literals and valueless attributes as null. */
  attributes: Map<string, string | null>
  /** Index just past the tag's closing `>`. */
  end: number
  selfClosing: boolean
}

/** Reads the attributes of the tag whose name ends at `start`. */
function readTag(source: string, start: number): Tag {
  const attributes = new Map<string, string | null>()
  let selfClosing = false
  let i = start
  while (i < source.length) {
    while (/\s/.test(source[i] ?? '')) i++
    const char = source[i]
    if (char === undefined) break
    if (char === '>') {
      i++
      break
    }
    if (char === '/') {
      selfClosing = true
      i++
      continue
    }
    selfClosing = false
    if (char === '{') {
      i = skipExpression(source, i) // spread or shorthand
      continue
    }
    const nameStart = i
    while (i < source.length && !/[\s=>/]/.test(source[i]!)) i++
    const name = source.slice(nameStart, i)
    while (/\s/.test(source[i] ?? '')) i++
    if (source[i] !== '=') {
      attributes.set(name, null)
      continue
    }
    i++
    while (/\s/.test(source[i] ?? '')) i++
    const opener = source[i]
    if (opener === '"' || opener === "'") {
      // HTML attribute values have no escapes: the value ends at the next matching quote.
      const close = source.indexOf(opener, i + 1)
      if (close < 0) {
        attributes.set(name, null) // unterminated: not a usable literal
        i = source.length
      } else {
        attributes.set(name, source.slice(i + 1, close))
        i = close + 1
      }
    } else if (opener === '{') {
      i = skipExpression(source, i)
      attributes.set(name, null)
    } else if (opener === '`') {
      const end = jsStringEnd(source, i)
      i = end < 0 ? source.length : end
      attributes.set(name, null)
    } else {
      const valueStart = i
      while (i < source.length && !/[\s>]/.test(source[i]!)) i++
      attributes.set(name, source.slice(valueStart, i))
    }
  }
  return { attributes, end: i, selfClosing }
}

/**
 * Literal `service` attributes of every live embed in an .astro source, whatever name the component
 * was imported under. Expression values are skipped; the component's render-time check covers those.
 *
 * One pass over the template. In plain markup it reads tags. Inside a `{…}` expression it also
 * skips JS comments and strings, so a commented-out or quoted embed is never reported. HTML
 * comments and the content of script, style, textarea and `is:raw` elements are skipped too. Every
 * skip jumps forward with indexOf and stops the scan when its closer is missing, so the pass is
 * linear even on malformed input.
 */
export function findEmbedServices(source: string): string[] {
  const parts = splitAstro(source)
  if (!parts) return []
  const names = embedNames(parts.frontmatter)
  const text = parts.template
  const services: string[] = []
  let depth = 0 // > 0 while inside a {…} expression
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (char === '<') {
      if (text.startsWith('<!--', i)) {
        const close = text.indexOf('-->', i + 4)
        if (close < 0) break
        i = close + 3
        continue
      }
      TAG_NAME.lastIndex = i + 1
      const name = TAG_NAME.exec(text)?.[0]
      if (!name) {
        i++ // a closing tag, a fragment, or a `<` used as an operator
        continue
      }
      const tag = readTag(text, i + 1 + name.length)
      i = tag.end
      if (names.has(name)) {
        const service = tag.attributes.get('service')
        if (typeof service === 'string') services.push(service)
      }
      if (!tag.selfClosing && (RAW_TEXT.has(name) || tag.attributes.has('is:raw'))) {
        const close = text.indexOf(`</${name}`, i)
        if (close < 0) break
        i = close
      }
      continue
    }

    if (char === '{') depth++
    else if (char === '}' && depth > 0) depth--
    else if (depth > 0) {
      if (isQuote(char)) {
        const end = jsStringEnd(text, i)
        if (end < 0) break
        i = end
        continue
      }
      const afterComment = jsCommentEnd(text, i)
      if (afterComment < 0) break
      if (afterComment > i) {
        i = afterComment
        continue
      }
    }
    i++
  }
  return services
}

/**
 * Is `file` inside `dir`? Vite passes module ids with forward slashes on every platform, while a
 * directory path from Node uses backslashes on Windows, where drive-letter case can differ too.
 */
export function isInDir(file: string, dir: string): boolean {
  const posix = (path: string): string => path.replace(/\\/g, '/')
  const directory = posix(dir).replace(/\/*$/, '/')
  const target = posix(file)
  const windows = /^[A-Za-z]:\//.test(directory)
  return windows ? target.toLowerCase().startsWith(directory.toLowerCase()) : target.startsWith(directory)
}

export function scanError(file: string, slug: string, allowed: string[]): string {
  const listed = allowed.join(', ') || 'none'
  return (
    `[astro-consent] ${file}: <ConsentEmbed service="${slug}"> but "${slug}" is not listed in ` +
    `src/data/privacy.json (services: ${listed}). Add it there or remove the embed.`
  )
}
