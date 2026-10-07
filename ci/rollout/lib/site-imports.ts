// Resolves a file's relative imports to site-relative paths. Imports that are not relative
// (aliases such as `@/…`, packages) are never followed: callers treat them as unknown.
import { posix } from 'node:path'
import ts from 'typescript'
import { parseAstro } from './astro-ast'
import { importsOf, parseModule } from './ts-ast'
import type { SiteFiles } from './site-files'

/** Default-import local name → site-relative path, for relative `.astro` imports in `frontmatter`. */
export function astroImports(file: string, frontmatter: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!frontmatter) return out
  for (const imp of importsOf(parseModule(frontmatter))) {
    if (!imp.defaultName || imp.typeOnly || !imp.from.endsWith('.astro') || !imp.from.startsWith('.')) continue
    out.set(imp.defaultName, posix.normalize(posix.join(posix.dirname(file), imp.from)))
  }
  return out
}

const EXTENSIONS = ['', '.ts', '.js', '.mjs', '.json', '/index.ts', '/index.js']

/** The existing site file a relative module specifier in `file` points at, or null. */
export function resolveRelative(files: SiteFiles, file: string, from: string): string | null {
  if (!from.startsWith('./') && !from.startsWith('../')) return null
  const base = posix.normalize(posix.join(posix.dirname(file), from))
  for (const ext of EXTENSIONS) {
    if (files.exists(base + ext)) return base + ext
  }
  return null
}

/**
 * Module prefixes (`@components/`) and exact names (`$layout`) from tsconfig.json
 * `compilerOptions.paths`; `exactAstro` are the exact names that map to an `.astro` file.
 */
function tsconfigAliases(files: SiteFiles): { prefixes: string[]; exact: string[]; exactAstro: string[] } {
  const out = { prefixes: [] as string[], exact: [] as string[], exactAstro: [] as string[] }
  if (!files.exists('tsconfig.json')) return out
  const { config } = ts.parseConfigFileTextToJson('tsconfig.json', files.read('tsconfig.json')) as { config?: unknown }
  const paths = (config as { compilerOptions?: { paths?: unknown } } | undefined)?.compilerOptions?.paths
  if (typeof paths !== 'object' || paths === null) return out
  for (const [key, targets] of Object.entries(paths)) {
    if (key.endsWith('*')) {
      out.prefixes.push(key.slice(0, -1))
      continue
    }
    out.exact.push(key)
    if (Array.isArray(targets) && targets.some((t) => typeof t === 'string' && t.endsWith('.astro'))) out.exactAstro.push(key)
  }
  return out
}

/**
 * `.astro` imports in `.astro` frontmatter that go through a path alias (`@/…`, `~/…` or a
 * tsconfig `paths` key). They are never followed, so what they render is unknown to detect.
 * Files that do not parse are skipped (detect reports them as parse errors).
 */
export function aliasedAstroImports(files: SiteFiles): { file: string; specifier: string }[] {
  const { prefixes, exact, exactAstro } = tsconfigAliases(files)
  const isAlias = (from: string): boolean =>
    from.startsWith('@/') || from.startsWith('~/') || exact.includes(from) || prefixes.some((p) => p !== '' && from.startsWith(p))
  const out: { file: string; specifier: string }[] = []
  for (const file of files.list('src/**/*.astro')) {
    let frontmatter: string
    try {
      frontmatter = parseAstro(files.read(file)).frontmatter?.text ?? ''
    } catch {
      continue
    }
    if (!frontmatter) continue
    for (const imp of importsOf(parseModule(frontmatter))) {
      if (imp.typeOnly || !isAlias(imp.from)) continue
      if (imp.from.endsWith('.astro') || exactAstro.includes(imp.from)) out.push({ file, specifier: imp.from })
    }
  }
  return out
}
