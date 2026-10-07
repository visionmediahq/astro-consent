// TypeScript-compiler helpers for astro.config.* and frontmatter. Offsets are UTF-16 string
// indices; use `node.getStart(sf)` (not `node.pos`, which includes leading trivia) to splice.
import ts from 'typescript'

export interface ImportInfo {
  from: string
  defaultName: string | null
  namespace: string | null
  named: { imported: string; local: string }[]
  typeOnly: boolean
  /** The whole import declaration, without leading trivia. */
  start: number
  end: number
}

export function parseModule(text: string): ts.SourceFile {
  return ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** Strips `( … )`, `as T`, `satisfies T` and `x!`. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression
  }
  return e
}

function topLevelConst(sf: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl
    }
  }
  return null
}

function defineConfigArg(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  const e = unwrap(expr)
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'defineConfig') return null
  const arg = e.arguments[0]
  if (!arg) return null
  const obj = unwrap(arg)
  return ts.isObjectLiteralExpression(obj) ? obj : null
}

/**
 * The object literal passed to `defineConfig` in the default export, directly
 * (`export default defineConfig({…})`) or through a top-level const. Null for anything else:
 * a plain object, a function argument, a config built elsewhere.
 */
export function findDefineConfig(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const stmt of sf.statements) {
    if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue
    const value = unwrap(stmt.expression)
    if (ts.isIdentifier(value)) {
      const init = topLevelConst(sf, value.text)?.initializer
      return init ? defineConfigArg(init) : null
    }
    return defineConfigArg(value)
  }
  return null
}

/** The value of property `name` (the identifier itself for a shorthand), or null. */
export function propertyOf(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name
    if (!ts.isPropertyAssignment(prop)) continue
    const key = prop.name
    if ((ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && key.text === name) {
      return prop.initializer
    }
  }
  return null
}

/**
 * What a top-level identifier holds: the string of a `const` string literal (or a template
 * literal without `${}`), the module it is imported from, or null when it cannot be known
 * statically (`let`, `${}` substitutions, non-strings, unknown names).
 */
export function resolveIdentifier(sf: ts.SourceFile, name: string): string | { importFrom: string } | null {
  for (const imp of importsOf(sf)) {
    if (imp.defaultName === name || imp.namespace === name || imp.named.some((n) => n.local === name)) {
      return { importFrom: imp.from }
    }
  }
  const init = topLevelConst(sf, name)?.initializer
  if (!init) return null
  const value = unwrap(init)
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : null
}

/** Every import declaration, in source order. */
export function importsOf(sf: ts.SourceFile): ImportInfo[] {
  const out: ImportInfo[] = []
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const clause = stmt.importClause
    const bindings = clause?.namedBindings
    out.push({
      from: stmt.moduleSpecifier.text,
      defaultName: clause?.name?.text ?? null,
      namespace: bindings && ts.isNamespaceImport(bindings) ? bindings.name.text : null,
      named:
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((el) => ({ imported: (el.propertyName ?? el.name).text, local: el.name.text }))
          : [],
      typeOnly: clause?.isTypeOnly ?? false,
      start: stmt.getStart(sf),
      end: stmt.end,
    })
  }
  return out
}
