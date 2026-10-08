import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectConfig } from '../../../ci/rollout/detect/config'
import { detectAstroMajor, detectCss } from '../../../ci/rollout/detect/css'
import { diskSite, fixtureSite } from '../../../ci/rollout/lib/site-files'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const pilot = (site: string) => fixtureSite(join(FIXTURES, site, 'before'))

const dirs: string[] = []
function inline(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'detect-config-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return diskSite(dir)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const lock = (versions: Record<string, string>): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries(Object.entries(versions).map(([k, v]) => [`node_modules/${k}`, { version: v }])),
  })

describe('detectConfig', () => {
  test('nhrk: server output, no sitemap integration key, tailwind vite plugin', () => {
    const site = pilot('nhrk')
    expect(detectConfig(site)).toEqual({
      path: 'astro.config.ts',
      hasIntegrations: false,
      hasTailwindVite: true,
      isDefineConfigObject: true,
      output: 'server',
    })
    expect(detectAstroMajor(site)).toBe(7)
  })

  test('aspomad has no integrations key; a-tak has one', () => {
    expect(detectConfig(pilot('aspomad')).hasIntegrations).toBe(false)
    expect(detectConfig(pilot('a-tak')).hasIntegrations).toBe(true)
  })

  test.each([
    ['a-tak', 6],
    ['aspomad', 6],
    ['domeijstapetserarverkstad', 6],
    ['munkforstradgardstjanst', 6],
    ['nhrk', 7],
    ['traforadling', 6],
    ['vasshallakatthotell', 7],
  ])('%s: astro major %i, output server', (site, major) => {
    expect(detectAstroMajor(pilot(site))).toBe(major)
    expect(detectConfig(pilot(site)).output).toBe('server')
  })

  test('finds astro.config.mjs and astro.config.ts', () => {
    const body = "import { defineConfig } from 'astro/config'\nexport default defineConfig({ integrations: [] })\n"
    expect(detectConfig(inline({ 'astro.config.mjs': body })).path).toBe('astro.config.mjs')
    expect(detectConfig(inline({ 'astro.config.ts': body })).path).toBe('astro.config.ts')
  })

  test('output defaults to static', () => {
    const site = inline({
      'astro.config.mjs': "import { defineConfig } from 'astro/config'\nexport default defineConfig({})\n",
    })
    expect(detectConfig(site)).toMatchObject({ output: 'static', hasIntegrations: false, hasTailwindVite: false })
  })

  test('isDefineConfigObject is false for a plain object and for defineConfig(identifier)', () => {
    const plain = inline({ 'astro.config.mjs': 'export default { integrations: [] }\n' })
    expect(detectConfig(plain).isDefineConfigObject).toBe(false)
    const ident = inline({
      'astro.config.mjs':
        "import { defineConfig } from 'astro/config'\nconst config = {}\nexport default defineConfig(config)\n",
    })
    expect(detectConfig(ident).isDefineConfigObject).toBe(false)
  })

  test('no config file at all does not throw', () => {
    expect(detectConfig(inline({ 'package.json': '{}' })).path).toBe('')
  })
})

describe('detectCss', () => {
  test('entry is the file that imports tailwindcss, wherever it lives', () => {
    const site = inline({
      'src/styles/global.css': 'body { color: red }',
      'src/assets/main.css': '@import "tailwindcss";\n@plugin "daisyui";\n',
    })
    expect(detectCss(site).entry).toBe('src/assets/main.css')
    expect(detectCss(inline({ 'src/a.css': 'a{}' })).entry).toBeNull()
  })

  test('daisyui 5 and tailwind 4 from the pilot lockfiles', () => {
    for (const s of ['a-tak', 'nhrk', 'vasshallakatthotell']) {
      const css = detectCss(pilot(s))
      expect(css.entry).toBe('src/styles/global.css')
      expect(css.tailwindMajor).toBe(4)
      expect(css.daisyuiMajor).toBe(5)
    }
  })

  test('no lockfile: majors are null, never a number', () => {
    const site = inline({ 'src/styles/global.css': '@import "tailwindcss";' })
    expect(detectCss(site)).toMatchObject({ tailwindMajor: null, daisyuiMajor: null })
    expect(detectAstroMajor(site)).toBe(0)
  })

  test('lockfile majors come from the top-level install', () => {
    const site = inline({
      'package-lock.json': lock({ astro: '5.2.0', tailwindcss: '3.4.1', daisyui: '4.12.0' }),
    })
    expect(detectCss(site)).toMatchObject({ tailwindMajor: 3, daisyuiMajor: 4 })
    expect(detectAstroMajor(site)).toBe(5)
  })

  test('primary inside a daisyui theme block', () => {
    const site = inline({
      'src/styles/global.css': '@import "tailwindcss";\n@plugin "daisyui/theme" {\n  name: "x";\n  --color-primary: #ff0000;\n}\n',
    })
    expect(detectCss(site).primaries).toEqual(['#ff0000'])
  })

  test('primaries: --client-primary and var() fallbacks in layout <style>, deduplicated in order', () => {
    expect(detectCss(pilot('a-tak')).primaries).toEqual(['#570df8', '#ff0000'])
    expect(detectCss(pilot('nhrk')).primaries).toEqual(['#570df8', '#a05200'])
    expect(detectCss(pilot('traforadling')).primaries).toEqual(['#2C5F3A', '#005229', '#0460c7'])
    expect(detectCss(pilot('munkforstradgardstjanst')).primaries).toContain('#ff3824')
    expect(detectCss(pilot('vasshallakatthotell')).primaries).toEqual(['#2aa5a5'])
  })

  test('primaries: tokens.css and global.css are read, -label variants are not', () => {
    expect(detectCss(pilot('aspomad')).primaries).toEqual(['#8B4513', '#570df8'])
    expect(detectCss(pilot('domeijstapetserarverkstad')).primaries).toEqual(['#eb5e28'])
  })

  test('a colour in a comment, or on another property, is ignored', () => {
    const site = inline({
      'src/styles/global.css': '@import "tailwindcss";\n/* --color-primary: #111111; */\n:root { --color-secondary: #222222; --color-primary-content: #333333; }\n',
    })
    expect(detectCss(site).primaries).toEqual([])
  })

  test('only layouts (files rendering <html>/<body>) contribute <style> colours', () => {
    const style = '<style>:root { --client-primary: #123456; }</style>'
    const site = inline({
      'src/layouts/Base.astro': `<html><head>${style}</head><body /></html>`,
      'src/components/Card.astro': '<div>x</div><style>:root { --client-primary: #abcdef; }</style>',
    })
    expect(detectCss(site).primaries).toEqual(['#123456'])
  })

  test('an .astro file the compiler cannot parse is skipped, not thrown', () => {
    const site = inline({
      'src/layouts/Broken.astro': '---\nconst x = {\n---\n<html><div></html>{',
      'src/layouts/Base.astro': '<html><style>:root { --client-primary: #123456; }</style></html>',
    })
    expect(() => detectCss(site)).not.toThrow()
    expect(detectCss(site).primaries).toEqual(['#123456'])
  })
})
