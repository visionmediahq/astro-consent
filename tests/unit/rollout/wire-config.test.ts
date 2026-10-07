import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { wireConfig } from '../../../ci/rollout/wire/config'
import { wireCss } from '../../../ci/rollout/wire/css'
import { applyEdits, Planner } from '../../../ci/rollout/wire/engine'
import { fixtureSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import type { Report, WirePlan } from '../../../ci/rollout/types'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const fixtureText = (site: string, tree: 'before' | 'expected', path: string) =>
  readFileSync(join(FIXTURES, site, tree, `${path}.txt`), 'utf8')

function memSite(files: Record<string, string>): SiteFiles {
  return {
    root: '/mem',
    list: (glob) => Object.keys(files).filter((p) => globToRegExp(glob).test(p)).sort(),
    read: (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`no such file: ${path}`)
      return text
    },
    exists: (path) => path in files,
  }
}

function report(over: { config?: Partial<Report['config']>; css?: Partial<Report['css']> } = {}): Report {
  return {
    site: 'example',
    domains: ['example.se'],
    astro: { major: 6, output: 'server' },
    config: { path: 'astro.config.ts', hasIntegrations: true, hasTailwindVite: true, isDefineConfigObject: true, ...over.config },
    css: { entry: 'src/styles/global.css', tailwindMajor: 4, daisyuiMajor: 5, primaries: [], ...over.css },
    layouts: [],
    footers: [],
    footerless: [],
    policyPage: null,
    iframes: [],
    trackers: [],
    banners: [],
    recaptcha: false,
    inventedMaps: [],
    alreadyWired: [],
    classification: 'notice',
    reasons: [],
  }
}

/** Plans with `wire`, then applies the plan's edits for `file`. */
function wired(
  wire: (p: Planner, r: Report) => void,
  files: SiteFiles,
  r: Report,
  file: string,
): { plan: WirePlan; text: string } {
  const p = new Planner(files)
  wire(p, r)
  const plan = p.result()
  if (!plan.ok) return { plan, text: files.read(file) }
  return { plan, text: applyEdits(files.read(file), plan.edits.filter((e) => e.file === file)) }
}

const config = (text: string, path = 'astro.config.ts') =>
  wired(wireConfig, memSite({ [path]: text }), report({ config: { path } }), path)

describe('wireConfig', () => {
  test('multi-line integrations with a trailing comma: consent() appended in the same style (domeij fixture)', () => {
    const site = 'domeijstapetserarverkstad'
    const { plan, text } = wired(wireConfig, fixtureSite(join(FIXTURES, site, 'before')), report(), 'astro.config.ts')
    expect(plan.ok).toBe(true)
    expect(text).toBe(fixtureText(site, 'expected', 'astro.config.ts'))
  })

  test('the other pilot configs with integrations come out as expected/', () => {
    for (const site of ['munkforstradgardstjanst', 'traforadling', 'vasshallakatthotell']) {
      const { text } = wired(wireConfig, fixtureSite(join(FIXTURES, site, 'before')), report(), 'astro.config.ts')
      expect(text, site).toBe(fixtureText(site, 'expected', 'astro.config.ts'))
    }
  })

  test('no integrations (aspomad fixture): integrations: [consent()], added as the last property', () => {
    const site = 'aspomad'
    const { plan, text } = wired(
      wireConfig,
      fixtureSite(join(FIXTURES, site, 'before')),
      report({ config: { hasIntegrations: false } }),
      'astro.config.ts',
    )
    expect(plan.ok).toBe(true)
    expect(text).toBe(fixtureText(site, 'expected', 'astro.config.ts'))
  })

  test('multi-line integrations without a trailing comma: a comma after the last element, none after consent()', () => {
    const { text } = config(
      "import { defineConfig } from 'astro/config'\nimport sitemap from '@astrojs/sitemap'\n\nexport default defineConfig({\n  integrations: [\n    sitemap()\n  ],\n})\n",
    )
    expect(text).toBe(
      "import { defineConfig } from 'astro/config'\nimport sitemap from '@astrojs/sitemap'\nimport consent from '@visionmediahq/astro-consent'\n\nexport default defineConfig({\n  integrations: [\n    sitemap(),\n    consent()\n  ],\n})\n",
    )
  })

  test('a line comment after the last element stays on its line', () => {
    const { text } = config(
      "import { defineConfig } from 'astro/config'\nimport sitemap from '@astrojs/sitemap'\n\nexport default defineConfig({\n  integrations: [\n    sitemap(), // pages\n  ],\n})\n",
    )
    expect(text).toContain('    sitemap(), // pages\n    consent(),\n  ],')
  })

  test("inline integrations: '[sitemap()]' → '[sitemap(), consent()]'", () => {
    const { text } = config(
      "import { defineConfig } from 'astro/config'\nimport sitemap from '@astrojs/sitemap'\n\nexport default defineConfig({\n  site: 'https://x.se',\n  integrations: [sitemap()],\n})\n",
    )
    expect(text).toContain('  integrations: [sitemap(), consent()],\n')
  })

  test("empty integrations: '[]' → '[consent()]'", () => {
    const { text } = config("import { defineConfig } from 'astro/config'\n\nexport default defineConfig({ integrations: [] })\n")
    expect(text).toContain('defineConfig({ integrations: [consent()] })')
  })

  test('no integrations and no trailing comma on the last property', () => {
    const { text } = config("import { defineConfig } from 'astro/config'\n\nexport default defineConfig({\n  output: 'static'\n})\n")
    expect(text).toBe(
      "import { defineConfig } from 'astro/config'\nimport consent from '@visionmediahq/astro-consent'\n\nexport default defineConfig({\n  output: 'static',\n  integrations: [consent()]\n})\n",
    )
  })

  test('the import goes after the last import, in its quote and semicolon style', () => {
    const { text } = config(
      'import { defineConfig } from "astro/config";\nimport sitemap from "@astrojs/sitemap";\n\nconst site = "https://x.se";\n\nexport default defineConfig({ site, integrations: [sitemap()] });\n',
    )
    expect(text).toBe(
      'import { defineConfig } from "astro/config";\nimport sitemap from "@astrojs/sitemap";\nimport consent from "@visionmediahq/astro-consent";\n\nconst site = "https://x.se";\n\nexport default defineConfig({ site, integrations: [sitemap(), consent()] });\n',
    )
  })

  test('.mjs config is handled the same', () => {
    const { plan, text } = config(
      "import { defineConfig } from 'astro/config'\nimport sitemap from '@astrojs/sitemap'\n\nexport default defineConfig({\n  integrations: [sitemap()],\n})\n",
      'astro.config.mjs',
    )
    expect(plan.ok && plan.edits.map((e) => e.file)).toEqual(['astro.config.mjs', 'astro.config.mjs'])
    expect(text).toBe(
      "import { defineConfig } from 'astro/config'\nimport sitemap from '@astrojs/sitemap'\nimport consent from '@visionmediahq/astro-consent'\n\nexport default defineConfig({\n  integrations: [sitemap(), consent()],\n})\n",
    )
  })

  test('a CRLF config with tab indents gets CRLF and tabs', () => {
    const { text } = config(
      "import { defineConfig } from 'astro/config'\r\nimport sitemap from '@astrojs/sitemap'\r\n\r\nexport default defineConfig({\r\n\tintegrations: [\r\n\t\tsitemap(),\r\n\t],\r\n})\r\n",
    )
    expect(text).toBe(
      "import { defineConfig } from 'astro/config'\r\nimport sitemap from '@astrojs/sitemap'\r\nimport consent from '@visionmediahq/astro-consent'\r\n\r\nexport default defineConfig({\r\n\tintegrations: [\r\n\t\tsitemap(),\r\n\t\tconsent(),\r\n\t],\r\n})\r\n",
    )
  })

  test('the config is defined through a const: the same edits', () => {
    const { text } = config(
      "import { defineConfig } from 'astro/config'\n\nconst config = defineConfig({\n  integrations: [],\n})\n\nexport default config\n",
    )
    expect(text).toContain('  integrations: [consent()],\n')
  })

  test('already wired: both targets skipped, no edits', () => {
    const r = config(
      "import { defineConfig } from 'astro/config'\nimport consent from '@visionmediahq/astro-consent'\n\nexport default defineConfig({ integrations: [consent()] })\n",
    )
    expect(r.plan).toEqual({ ok: true, edits: [], newFiles: [], skipped: ['config import', 'config integrations'] })
  })

  test('an existing import under another name is used for the call', () => {
    const { text } = config(
      "import { defineConfig } from 'astro/config'\nimport astroConsent from '@visionmediahq/astro-consent'\n\nexport default defineConfig({ integrations: [] })\n",
    )
    expect(text).toContain('integrations: [astroConsent()]')
  })

  test.each([
    ['not defineConfig({…})', "export default { integrations: [] }\n", /defineConfig/],
    [
      'integrations is not an array literal',
      "import { defineConfig } from 'astro/config'\nconst list = []\nexport default defineConfig({ integrations: list })\n",
      /array literal/,
    ],
    [
      'a spread could already hold integrations',
      "import { defineConfig } from 'astro/config'\nimport base from './base'\nexport default defineConfig({ ...base, output: 'static' })\n",
      /spread/,
    ],
    [
      'the name consent is taken',
      "import { defineConfig } from 'astro/config'\nimport consent from './my-consent'\nexport default defineConfig({ integrations: [] })\n",
      /consent/,
    ],
  ])('refuses: %s', (_name, text, reason) => {
    const { plan } = config(text)
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.refusals.map((r) => r.reason).join('\n')).toMatch(reason)
  })

  test('two integrations keys: found 2', () => {
    const { plan } = config(
      "import { defineConfig } from 'astro/config'\nexport default defineConfig({ integrations: [], integrations: [] })\n",
    )
    expect(!plan.ok && plan.refusals).toEqual([
      { file: 'astro.config.ts', target: 'config integrations', reason: expect.stringMatching(/^found 2\b/) as string },
    ])
  })

  test('no config file: a refusal', () => {
    const p = new Planner(memSite({}))
    wireConfig(p, report({ config: { path: '' } }))
    expect(p.result().ok).toBe(false)
  })
})

const css = (path: string, text: string) => wired(wireCss, memSite({ [path]: text }), report({ css: { entry: path } }), path)

describe('wireCss', () => {
  test('src/styles/global.css → ../../node_modules (every pilot fixture)', () => {
    for (const site of ['aspomad', 'domeijstapetserarverkstad', 'munkforstradgardstjanst', 'traforadling', 'vasshallakatthotell']) {
      const path = 'src/styles/global.css'
      const { plan, text } = wired(wireCss, fixtureSite(join(FIXTURES, site, 'before')), report(), path)
      expect(plan.ok, site).toBe(true)
      expect(text, site).toBe(fixtureText(site, 'expected', path))
    }
    expect(css('src/styles/global.css', '@import "tailwindcss";\n').text).toBe(
      '@import "tailwindcss";\n@source "../../node_modules/@visionmediahq/astro-consent/src";\n',
    )
  })

  test('src/global.css → ../node_modules', () => {
    expect(css('src/global.css', '@import "tailwindcss";\n').text).toBe(
      '@import "tailwindcss";\n@source "../node_modules/@visionmediahq/astro-consent/src";\n',
    )
  })

  test('inserted after the last top-level @import/@plugin; a @plugin "daisyui/theme" { … } block ends at its }', () => {
    const before = [
      '@import "tailwindcss";',
      '@plugin "daisyui";',
      '@plugin "daisyui/theme" {',
      '  name: "light";',
      '  --color-primary: oklch(50% 0.2 30);',
      '}',
      '',
      '@theme {',
      '  --font-sans: "Inter";',
      '}',
      '',
    ].join('\n')
    expect(css('src/styles/global.css', before).text).toBe(
      before.replace('}\n\n@theme', '}\n@source "../../node_modules/@visionmediahq/astro-consent/src";\n\n@theme'),
    )
  })

  test('@import inside a block, a comment or a string is not top level', () => {
    const before = [
      '@import "tailwindcss";',
      '/* @plugin "daisyui"; */',
      '@layer base {',
      '  @import "./inner.css";',
      '}',
      '.x::after { content: "@plugin \\"y\\";"; }',
      '',
    ].join('\n')
    expect(css('src/styles/global.css', before).text).toBe(
      before.replace('";\n/*', '";\n@source "../../node_modules/@visionmediahq/astro-consent/src";\n/*'),
    )
  })

  test('a comment on the same line stays with its statement', () => {
    expect(css('src/styles/global.css', '@import "tailwindcss"; /* v4 */\n.a { color: red; }\n').text).toBe(
      '@import "tailwindcss"; /* v4 */\n@source "../../node_modules/@visionmediahq/astro-consent/src";\n.a { color: red; }\n',
    )
  })

  test('CRLF stays CRLF', () => {
    expect(css('src/styles/global.css', '@import "tailwindcss";\r\n@plugin "daisyui";\r\n').text).toBe(
      '@import "tailwindcss";\r\n@plugin "daisyui";\r\n@source "../../node_modules/@visionmediahq/astro-consent/src";\r\n',
    )
  })

  test('already wired: skipped', () => {
    const r = css('src/styles/global.css', "@import 'tailwindcss';\n@source '../../node_modules/@visionmediahq/astro-consent/src';\n")
    expect(r.plan).toEqual({ ok: true, edits: [], newFiles: [], skipped: ['css @source'] })
  })

  test('no CSS entry: a refusal', () => {
    const p = new Planner(memSite({}))
    wireCss(p, report({ css: { entry: null } }))
    expect(p.result()).toEqual({
      ok: false,
      refusals: [{ file: '', target: 'css @source', reason: expect.stringMatching(/no CSS entry/) as string }],
    })
  })
})
