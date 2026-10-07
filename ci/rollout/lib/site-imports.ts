// Resolves a file's relative imports to site-relative paths. Imports that are not relative
// (aliases such as `@/…`, packages) are never followed: callers treat them as unknown.
import { posix } from 'node:path'
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
