// Detects the Tailwind CSS entry, the Tailwind/daisyUI majors and the site's primary colours.
import type { Report } from '../types'
import { elements, parseAstro } from '../lib/astro-ast'
import { majorOf } from '../lib/lockfile'
import type { SiteFiles } from '../lib/site-files'

const lockOf = (files: SiteFiles): string | null => (files.exists('package-lock.json') ? files.read('package-lock.json') : null)

/**
 * The installed Astro major. 0 means unknown: there is no lockfile, or astro is not in it and
 * package.json gives no readable range. Callers treat 0 as "unknown versions", never as old.
 */
export function detectAstroMajor(files: SiteFiles): number {
  const lock = lockOf(files)
  const fromLock = lock ? majorOf(lock, 'astro') : null
  if (fromLock !== null) return fromLock
  try {
    const pkg = JSON.parse(files.read('package.json')) as Record<string, Record<string, string> | undefined>
    const range = pkg['dependencies']?.['astro'] ?? pkg['devDependencies']?.['astro']
    const m = range ? /(\d+)\./.exec(range) : null
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

const COLOUR = String.raw`#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\([^)]*\)`
const DECL = new RegExp(
  String.raw`(?<![\w-])--(?:client|color)-primary\s*:\s*(?:(${COLOUR})|var\(\s*--client-primary\s*,\s*(${COLOUR})\s*\))\s*(?:[;}!]|$)`,
  'gm',
)

/** Literal colours assigned to --client-primary / --color-primary (incl. a var() fallback), in order. */
function primariesIn(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...text.matchAll(DECL)].map((m) => (m[1] ?? m[2])!)
}

function layoutStyles(files: SiteFiles): string[] {
  const out: string[] = []
  for (const path of files.list('src/**/*.astro')) {
    const text = files.read(path)
    if (!/<style[\s>]/.test(text)) continue
    let root
    try {
      root = parseAstro(text).root
    } catch {
      continue // reported as a needs-human reason elsewhere
    }
    if (elements(root, 'html').length === 0 && elements(root, 'body').length === 0) continue
    for (const style of elements(root, 'style')) out.push(text.slice(style.start, style.end))
  }
  return out
}

export function detectCss(files: SiteFiles): Report['css'] {
  const lock = lockOf(files)
  const cssFiles = files.list('**/*.css')
  const entry = cssFiles.find((p) => /@import\s+["']tailwindcss(?:\/[^"']*)?["']/.test(files.read(p))) ?? null
  const ordered = entry ? [entry, ...cssFiles.filter((p) => p !== entry && p.startsWith('src/'))] : cssFiles.filter((p) => p.startsWith('src/'))

  const seen = new Set<string>()
  const primaries: string[] = []
  for (const css of [...ordered.map((p) => files.read(p)), ...layoutStyles(files)]) {
    for (const colour of primariesIn(css)) {
      if (!seen.has(colour.toLowerCase())) {
        seen.add(colour.toLowerCase())
        primaries.push(colour)
      }
    }
  }
  return {
    entry,
    tailwindMajor: lock ? majorOf(lock, 'tailwindcss') : null,
    daisyuiMajor: lock ? majorOf(lock, 'daisyui') : null,
    primaries,
  }
}
