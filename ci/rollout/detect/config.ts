// Detects what astro.config.* looks like: where it is, whether it has an integrations key, uses the
// Tailwind Vite plugin, and sets output. Everything is read statically; nothing is executed.
import ts from 'typescript'
import type { Report } from '../types'
import { findDefineConfig, importsOf, parseModule, propertyOf } from '../lib/ts-ast'
import type { SiteFiles } from '../lib/site-files'

export type DetectedConfig = Report['config'] & { output: 'static' | 'server' }

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e

/** `export default { … }`, for configs that skip defineConfig. */
function plainDefaultObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const stmt of sf.statements) {
    if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue
    const value = unwrap(stmt.expression)
    return ts.isObjectLiteralExpression(value) ? value : null
  }
  return null
}

export function detectConfig(files: SiteFiles): DetectedConfig {
  const path = files.list('astro.config.*')[0]
  if (!path) return { path: '', hasIntegrations: false, hasTailwindVite: false, isDefineConfigObject: false, output: 'static' }

  const sf = parseModule(files.read(path))
  const define = findDefineConfig(sf)
  const obj = define ?? plainDefaultObject(sf)
  const output = obj ? propertyOf(obj, 'output') : null
  return {
    path,
    hasIntegrations: obj !== null && propertyOf(obj, 'integrations') !== null,
    hasTailwindVite: importsOf(sf).some((i) => i.from === '@tailwindcss/vite'),
    isDefineConfigObject: define !== null,
    output: output && ts.isStringLiteralLike(output) && output.text === 'server' ? 'server' : 'static',
  }
}
