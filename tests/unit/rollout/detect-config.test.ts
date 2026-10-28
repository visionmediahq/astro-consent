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
  test('a pilot fixture: server output, no sitemap integration key, tailwind vite plugin', () => {
    const site = pilot('site-1277834673')
    expect(detectConfig(site)).toEqual({
      path: 'astro.config.ts',
      hasIntegrations: false,
      hasTailwindVite: true,
      isDefineConfigObject: true,
      output: 'server',
    })
    expect(detectAstroMajor(site)).toBe(7)
  })

  test('one pilot fixture has no integrations key; another has one', () => {
    expect(detectConfig(pilot('site-1218869363')).hasIntegrations).toBe(false)
    expect(detectConfig(pilot('site-1271984151')).hasIntegrations).toBe(true)
  })

  test.each([
    ['site-1271984151', 6],
    ['site-1218869363', 6],
    ['site-1243511314', 6],
    ['site-1286040212', 6],
    ['site-1277834673', 7],
    ['site-1243335919', 6],
    ['site-1245311266', 7],
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
    for (const s of ['site-1271984151', 'site-1277834673', 'site-1245311266']) {
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

  // #101: the daisyUI parts the banner uses, from the @plugin block in the entry or another src CSS file.
  test('daisyui: the plugin block is read from the entry and src CSS', () => {
    const bare = inline({ 'src/styles/global.css': '@import "tailwindcss";\n@plugin "daisyui";\n' })
    expect(detectCss(bare).daisyui).toEqual({ plugin: true, missing: [], prefix: '', ownClasses: [] })
    const split = inline({
      'src/styles/global.css': '@import "tailwindcss";\n@import "./daisy.css";\n',
      'src/styles/daisy.css': '@plugin "daisyui" {\n  include: button;\n}\n.card { padding: 2rem; }\n',
    })
    expect(detectCss(split).daisyui).toMatchObject({ plugin: true, missing: ['card', 'toggle', 'badge', 'link', 'checkbox'], ownClasses: ['card'] })
    expect(detectCss(inline({ 'src/styles/global.css': '@import "tailwindcss";\n' })).daisyui!.plugin).toBe(false)
  })

  test('primary inside a daisyui theme block', () => {
    const site = inline({
      'src/styles/global.css': '@import "tailwindcss";\n@plugin "daisyui/theme" {\n  name: "x";\n  --color-primary: #ff0000;\n}\n',
    })
    expect(detectCss(site).primaries).toEqual(['#ff0000'])
  })

  test('primaries: --client-primary and var() fallbacks in layout <style>, deduplicated in order', () => {
    expect(detectCss(pilot('site-1271984151')).primaries).toEqual(['#570df8', '#ff0000'])
    expect(detectCss(pilot('site-1277834673')).primaries).toEqual(['#570df8', '#a05200'])
    expect(detectCss(pilot('site-1243335919')).primaries).toEqual(['#2C5F3A', '#005229', '#0460c7'])
    expect(detectCss(pilot('site-1286040212')).primaries).toContain('#ff3824')
    expect(detectCss(pilot('site-1245311266')).primaries).toEqual(['#2aa5a5'])
  })

  test('primaries: tokens.css and global.css are read, -label variants are not', () => {
    expect(detectCss(pilot('site-1218869363')).primaries).toEqual(['#8B4513', '#570df8'])
    expect(detectCss(pilot('site-1243511314')).primaries).toEqual(['#eb5e28'])
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
