// Shared helpers for the .astro targets: importing one of the package's components into a file's
// frontmatter, and the two places markup is inserted (before a node, or as an element's last
// child). Insertions follow the file's own line endings and indentation.
import { type AstroNode, parseAstro } from '../lib/astro-ast'
import { importsOf, parseModule } from '../lib/ts-ast'
import { PACKAGE } from './config'
import { type EditMode, eolOf, type Hit, type Planner } from './engine'

export type PackageComponent = 'ConsentBanner' | 'PrivacyLinks' | 'ConsentEmbed'

export const componentPath = (name: PackageComponent): string => `${PACKAGE}/components/${name}.astro`

/** The whitespace that starts the line `pos` is on. */
export function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

/**
 * A target whose locate step also works out the text for each hit: `plan` returns every candidate
 * splice (the engine refuses unless there is exactly one), and the chosen one's text is used.
 */
export function spliceTarget(
  planner: Planner,
  name: string,
  file: string,
  alreadyWired: () => boolean,
  plan: () => { hit: Hit; text: string }[],
  mode: EditMode = 'insert-before',
): void {
  let planned: { hit: Hit; text: string }[] = []
  planner.target(
    name,
    file,
    alreadyWired,
    () => {
      planned = plan()
      return planned.map((p) => p.hit)
    },
    (hit) => planned.find((p) => p.hit === hit)!.text,
    mode,
  )
}

/** Only whitespace between the start of its line and `pos`. */
const startsLine = (text: string, pos: number): boolean => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos))

/** Parses an .astro file; a parse error becomes the target's refusal (the engine catches it). */
export function parseFile(planner: Planner, file: string): { text: string; tree: ReturnType<typeof parseAstro> } {
  const text = planner.files.read(file)
  return { text, tree: parseAstro(text) }
}

/** Elements, components and `{…}` expressions holding markup: what counts as a child element. */
export function childElements(node: AstroNode): AstroNode[] {
  return node.children.filter(
    (c) =>
      (c.type === 'element' && c.name !== 'script' && c.name !== 'style') ||
      c.type === 'component' ||
      (c.type === 'expression' && c.children.length > 0),
  )
}

/** `node` and its parent, for every node matching `match`, in document order. */
export function withParents(root: AstroNode, match: (n: AstroNode) => boolean): { node: AstroNode; parent: AstroNode }[] {
  const out: { node: AstroNode; parent: AstroNode }[] = []
  const visit = (n: AstroNode): void => {
    for (const c of n.children) {
      if (match(c)) out.push({ node: c, parent: n })
      visit(c)
    }
  }
  visit(root)
  return out
}

/** Every component use named `name` anywhere under `node`. */
export function usesOf(node: AstroNode, name: string): AstroNode[] {
  const out: AstroNode[] = []
  const visit = (n: AstroNode): void => {
    if (n.type === 'component' && n.name === name) out.push(n)
    n.children.forEach(visit)
  }
  visit(node)
  return out
}

/** `markup` placed right before `node`: on its own line at the node's indent when the node starts a line. */
export function beforeNode(text: string, node: AstroNode, markup: string): { hit: Hit; text: string } {
  const hit = { start: node.start, end: node.start }
  return { hit, text: startsLine(text, node.start) ? `${markup}${eolOf(text)}${indentAt(text, node.start)}` : markup }
}

/**
 * `markup` placed as the last child of `node`, just before its closing tag: on its own line at the
 * indent of the node's last child when the closing tag starts a line, inline otherwise. Throws for
 * a self-closing node, which has no children to append to.
 */
export function lastChildOf(text: string, node: AstroNode, markup: string): { hit: Hit; text: string } {
  const close = text.lastIndexOf('</', node.end - 1)
  if (close < node.start || !/^<\/[^>]*>$/.test(text.slice(close, node.end))) {
    throw new Error(`<${node.name ?? ''}> at offset ${node.start} has no closing tag`)
  }
  if (!startsLine(text, close)) return { hit: { start: close, end: close }, text: markup }
  const lineStart = text.lastIndexOf('\n', close - 1) + 1
  const last = node.children.filter((c) => c.type !== 'text').at(-1)
  const closeIndent = indentAt(text, close)
  const indent = last ? indentAt(text, last.start) : closeIndent + (closeIndent.includes('\t') ? '\t' : '  ')
  return { hit: { start: lineStart, end: lineStart }, text: `${indent}${markup}${eolOf(text)}` }
}

/**
 * Plans the frontmatter import of the package component `name` in `file` and returns the local
 * name to use in the markup: an existing default import of it is reused (the target is skipped).
 * The import goes after the last import, in its quote and semicolon style; with no imports, first
 * in the frontmatter; with no frontmatter, in a new one. A name already bound to something else is
 * a refusal.
 */
export function wireImport(planner: Planner, file: string, name: PackageComponent): string {
  const target = `${name} import (${file})`
  let text: string
  let tree: ReturnType<typeof parseAstro>
  try {
    ;({ text, tree } = parseFile(planner, file))
  } catch (e) {
    planner.refuse(file, target, e instanceof Error ? e.message : String(e))
    return name
  }
  const spec = componentPath(name)
  const fm = tree.frontmatter
  const sf = parseModule(fm?.text ?? '')
  const imports = importsOf(sf)
  const own = imports.find((i) => i.from === spec && i.defaultName !== null && !i.typeOnly)
  const local = own?.defaultName ?? name
  if (!own) {
    const taken =
      imports.some((i) => i.defaultName === name || i.namespace === name || i.named.some((n) => n.local === name)) ||
      new RegExp(String.raw`\b(?:const|let|var|function|class)\s+${name}\b`).test(fm?.text ?? '')
    if (taken) {
      planner.refuse(file, target, `the name '${name}' is already used in ${file}`)
      return name
    }
  }
  const eol = eolOf(text)
  planner.target(
    target,
    file,
    () => own !== undefined,
    (): Hit[] => {
      if (!fm) return [{ start: 0, end: 0 }]
      const last = imports.at(-1)
      if (!last) return [{ start: fm.start, end: fm.start }]
      const end = fm.start + last.end
      // A comment after the import on the same line stays with it.
      const rest = /^[ \t]*(?:\/\/[^\r\n]*|\/\*[^\r\n]*?\*\/[ \t]*)?(?=\r?\n|$)/.exec(text.slice(end))
      const at = end + (rest ? rest[0].length : 0)
      return [{ start: at, end: at }]
    },
    () => {
      const last = imports.at(-1)
      const lastText = last ? fm!.text.slice(last.start, last.end) : ''
      const quote = /(['"])[^'"]*\1\s*;?\s*$/.exec(lastText)?.[1] ?? "'"
      const first = sf.statements[0]
      const semi = last ? /;\s*$/.test(lastText) : first !== undefined && /;\s*$/.test(first.getText(sf))
      const line = `import ${name} from ${quote}${spec}${quote}${semi ? ';' : ''}`
      return fm ? `${eol}${line}` : `---${eol}${line}${eol}---${eol}`
    },
    'insert-after',
  )
  return local
}
