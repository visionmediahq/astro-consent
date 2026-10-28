// The daisyUI parts the package's markup uses (#101). A site that loads daisyUI with an `include:`
// list without them, or an `exclude:` list with them, ships the banner half-styled: no card padding,
// Neka and Acceptera alla touching, bare checkboxes for the category switches. detect reads the
// `@plugin "daisyui"` block; verify step 2 looks for each part in the built CSS.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Part (daisyUI's name in `include:`/`exclude:`) → a class the package uses that only that part
 * styles, and the class a site might style itself. The marker is a modifier, not the base class, so
 * a site's own `.card` or `.toggle` rule does not pass for daisyUI's.
 */
export const PARTS = {
  button: { marker: 'btn-ghost', base: 'btn' },
  card: { marker: 'card-body', base: 'card' },
  toggle: { marker: 'toggle-sm', base: 'toggle' },
  badge: { marker: 'badge-neutral', base: 'badge' },
  link: { marker: 'link-hover', base: 'link' },
  // The embed placeholder's "Visa alltid"; the banner's own switches are toggles.
  checkbox: { marker: 'checkbox-sm', base: 'checkbox', embedsOnly: true },
} as const
// `rounded-box` needs no part: daisyUI's theme extension defines the `box` radius, which no
// include list filters (a demo build with `include: button, link` still has it).

export type Part = keyof typeof PARTS
const NAMES = Object.keys(PARTS) as Part[]

/** Of `parts`, those the site needs: the embed-only ones only when it has a service. */
export function neededParts(parts: readonly Part[], embeds: boolean): Part[] {
  return parts.filter((p) => embeds || !('embedsOnly' in PARTS[p]))
}

export interface DaisyuiPlugin {
  /** An `@plugin "daisyui"` (not `daisyui/theme`) in one of the site's CSS files. */
  plugin: boolean
  /** Parts the package needs that the plugin's `include:`/`exclude:` leave out. */
  missing: Part[]
  /** The plugin's `prefix:` option; the package's class names are unprefixed. */
  prefix: string
  /** Of the missing parts, those whose base class the site's CSS styles itself (komplett-ekonomi's `.card`). */
  ownClasses: string[]
}

const PLUGIN = /@plugin\s+["']daisyui["']\s*(?:;|\{([^}]*)\})/g

const listOf = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)

/** Every `@plugin "daisyui"` block in `cssTexts`; comments are ignored. */
export function readDaisyuiPlugin(cssTexts: string[]): DaisyuiPlugin {
  const texts = cssTexts.map((css) => css.replace(/\/\*[\s\S]*?\*\//g, ''))
  const missing = new Set<Part>()
  let plugin = false
  let prefix = ''
  for (const text of texts) {
    for (const m of text.matchAll(PLUGIN)) {
      plugin = true
      const options = new Map<string, string>()
      for (const decl of (m[1] ?? '').split(';')) {
        const colon = decl.indexOf(':')
        if (colon > 0) options.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim())
      }
      const include = options.has('include') ? listOf(options.get('include')!) : null
      const exclude = options.has('exclude') ? listOf(options.get('exclude')!) : []
      for (const part of NAMES) if ((include && !include.includes(part)) || exclude.includes(part)) missing.add(part)
      prefix ||= (options.get('prefix') ?? '').replace(/^["']|["']$/g, '')
    }
  }
  const parts = NAMES.filter((p) => missing.has(p))
  const ownClasses = parts
    .map((p) => PARTS[p].base)
    .filter((base) => texts.some((text) => new RegExp(String.raw`\.${base}(?![\w-])`).test(text)))
  return { plugin, missing: parts, prefix, ownClasses }
}

/** Parts whose marker class has no rule in the built CSS (verify step 2). */
export function partsMissingFromBuild(cssTexts: string[]): Part[] {
  return NAMES.filter((part) => !cssTexts.some((css) => new RegExp(String.raw`\.${PARTS[part].marker}(?![\w-])`).test(css)))
}

/** The CSS a build ships: every `.css` file under `dist`, and the `<style>` blocks of its HTML (Astro inlines small sheets). */
export function builtCss(dist: string): string[] {
  let files: string[]
  try {
    files = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const out: string[] = []
  for (const file of files.sort()) {
    const path = join(dist, file)
    if (/\.css$/i.test(file) && statSync(path).isFile()) out.push(readFileSync(path, 'utf8'))
    else if (/\.html?$/i.test(file) && statSync(path).isFile())
      for (const m of readFileSync(path, 'utf8').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(m[1]!)
  }
  return out
}
