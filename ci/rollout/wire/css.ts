// Wires the Tailwind CSS entry: an `@source` line for the package's components, so Tailwind
// generates their classes. It goes after the last top-level @import/@plugin statement, with the
// path made relative to the entry's location.
import { posix } from 'node:path'
import type { Report } from '../types'
import { eolOf, type Hit, type Planner } from './engine'
import { PACKAGE } from './config'
import { topLevelImportEnds } from './css-imports'

export { topLevelImportEnds }

const TARGET = 'css @source'

/** The `@source` path for a CSS entry at `entry` (site-relative): node_modules is at the site root. */
export function sourcePath(entry: string): string {
  const rel = posix.relative(posix.dirname(entry), `node_modules/${PACKAGE}/src`)
  return rel.startsWith('.') ? rel : `./${rel}`
}

export function wireCss(planner: Planner, report: Report): void {
  const file = report.css.entry
  if (!file) {
    planner.refuse('', TARGET, 'no CSS entry with @import "tailwindcss"')
    return
  }
  const source = sourcePath(file)
  planner.target(
    TARGET,
    file,
    () => {
      const css = planner.files.read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      return new RegExp(String.raw`@source\s+["'][^"']*${PACKAGE.replace(/[/.]/g, '\\$&')}[^"']*["']`).test(css)
    },
    (): Hit[] => {
      const css = planner.files.read(file)
      const end = topLevelImportEnds(css).at(-1)
      if (end === undefined) return []
      // A comment after the statement on the same line stays with it.
      const rest = /^[ \t]*(?:\/\*[^\n]*?\*\/[ \t]*)*(?=\r?\n|$)/.exec(css.slice(end))
      const at = end + (rest ? rest[0].length : 0)
      return [{ start: at, end: at }]
    },
    () => `${eolOf(planner.files.read(file))}@source "${source}";`,
    'insert-after',
  )
}
