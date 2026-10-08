import ts from 'typescript'
import { describe, expect, test } from 'vitest'
import { findDefineConfig, importsOf, parseModule, propertyOf, resolveIdentifier } from '../../../ci/rollout/lib/ts-ast'

const text = (sf: ts.SourceFile, node: ts.Node | null): string | null => (node ? node.getText(sf) : null)

describe('findDefineConfig and propertyOf', () => {
  test('export default defineConfig({...})', () => {
    const sf = parseModule("export default defineConfig({ output: 'server', integrations: [a()] })")
    const obj = findDefineConfig(sf)!
    expect(obj).not.toBeNull()
    const output = propertyOf(obj, 'output')!
    expect(ts.isStringLiteral(output) && output.text).toBe('server')
    const integrations = propertyOf(obj, 'integrations')!
    expect(ts.isArrayLiteralExpression(integrations)).toBe(true)
    expect(text(sf, integrations)).toBe('[a()]')
  })

  test('no integrations → null', () => {
    const sf = parseModule("export default defineConfig({ site: 'https://x.se' })")
    expect(propertyOf(findDefineConfig(sf)!, 'integrations')).toBeNull()
  })

  test('quoted keys and shorthand properties', () => {
    const sf = parseModule("const integrations = []\nexport default defineConfig({ 'output': 'static', integrations })")
    const obj = findDefineConfig(sf)!
    expect(text(sf, propertyOf(obj, 'output'))).toBe("'static'")
    expect(text(sf, propertyOf(obj, 'integrations'))).toBe('integrations')
  })

  test('through a const', () => {
    const sf = parseModule('const config = defineConfig({ vite: {} })\nexport default config')
    expect(propertyOf(findDefineConfig(sf)!, 'vite')).not.toBeNull()
  })

  test('a plain object or a function argument is not a defineConfig object', () => {
    expect(findDefineConfig(parseModule('export default { output: "server" }'))).toBeNull()
    expect(findDefineConfig(parseModule('export default defineConfig(() => ({}))'))).toBeNull()
  })
})

describe('resolveIdentifier', () => {
  test('a const string', () => {
    const sf = parseModule("const MAP = 'https://maps.google.com/maps?q=x&output=embed'")
    expect(resolveIdentifier(sf, 'MAP')).toBe('https://maps.google.com/maps?q=x&output=embed')
  })

  test('a template literal without substitutions, and `as const`', () => {
    const sf = parseModule('const A = `https://a.se`\nconst B = "https://b.se" as const')
    expect(resolveIdentifier(sf, 'A')).toBe('https://a.se')
    expect(resolveIdentifier(sf, 'B')).toBe('https://b.se')
  })

  test('an import', () => {
    expect(resolveIdentifier(parseModule("import data from '../data/site.json'"), 'data')).toEqual({
      importFrom: '../data/site.json',
    })
    expect(resolveIdentifier(parseModule("import { MAP as M } from './c'"), 'M')).toEqual({ importFrom: './c' })
  })

  test('a template literal with ${} → null', () => {
    const sf = parseModule('const id = "x"\nconst MAP = `https://maps.google.com/maps?q=${id}`')
    expect(resolveIdentifier(sf, 'MAP')).toBeNull()
  })

  test('let, unknown names and non-strings → null', () => {
    const sf = parseModule("let A = 'x'\nconst N = 1")
    expect(resolveIdentifier(sf, 'A')).toBeNull()
    expect(resolveIdentifier(sf, 'N')).toBeNull()
    expect(resolveIdentifier(sf, 'Z')).toBeNull()
  })
})

describe('importsOf', () => {
  test('lists every import with its bindings and offsets', () => {
    const src =
      "import Layout from '../layouts/Base.astro'\nimport { a, b as c } from 'x'\nimport * as ns from 'y'\nimport type { T } from 'z'\nimport '../styles/global.css'\nconst q = 1"
    const sf = parseModule(src)
    const imports = importsOf(sf)
    expect(imports.map(({ start: _s, end: _e, ...rest }) => rest)).toEqual([
      { from: '../layouts/Base.astro', defaultName: 'Layout', namespace: null, named: [], typeOnly: false },
      {
        from: 'x',
        defaultName: null,
        namespace: null,
        named: [
          { imported: 'a', local: 'a' },
          { imported: 'b', local: 'c' },
        ],
        typeOnly: false,
      },
      { from: 'y', defaultName: null, namespace: 'ns', named: [], typeOnly: false },
      { from: 'z', defaultName: null, namespace: null, named: [{ imported: 'T', local: 'T' }], typeOnly: true },
      { from: '../styles/global.css', defaultName: null, namespace: null, named: [], typeOnly: false },
    ])
    expect(src.slice(imports[0]!.start, imports[0]!.end)).toBe("import Layout from '../layouts/Base.astro'")
  })
})
