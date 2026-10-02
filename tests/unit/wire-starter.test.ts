import { expect, test } from 'vitest'
import { wireBase, wireConfig, wireCss, wireFooter } from '../../ci/wire-starter'

// Snippets of the real astro-starter files.
const CONFIG = `import { defineConfig } from 'astro/config'
import node from '@astrojs/node'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

// https://astro.build/config
export default defineConfig({
  output: 'server',

  integrations: [
    // In SSR mode pages are not auto-discovered.
    sitemap(),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
})
`
const CSS = '@import "tailwindcss";\n@plugin "daisyui";' // no trailing newline, as in the starter
const BASE = `---
import SEO from '../components/SEO.astro'
import VisionFooter from '../components/VisionFooter.astro'
import '../styles/global.css'
---

<html lang="sv">
  <body class="bg-base-100 text-base-content">
    <slot />
    <VisionFooter />
  </body>
</html>
`
const FOOTER = `---
// Vision Media branding footer — present on every client site.
---

<footer class="bg-neutral py-3">
  <a href="https://visionmedia.io">Vision Media</a>
</footer>
`

test('wireConfig adds the import and consent() to integrations', () => {
  const wired = wireConfig(CONFIG)
  expect(wired).toContain("import consent from '@visionmediahq/astro-consent'")
  expect(wired).toMatch(/integrations: \[\s*consent\(\),/)
  expect(wired).toContain('sitemap(),')
})

test('wireCss appends the @source line when the file has no trailing newline', () => {
  const wired = wireCss(CSS)
  expect(wired).toBe(
    '@import "tailwindcss";\n@plugin "daisyui";\n@source "../../node_modules/@visionmediahq/astro-consent/src";\n',
  )
})

test('wireBase imports ConsentBanner and renders it before VisionFooter', () => {
  const wired = wireBase(BASE)
  expect(wired).toContain("import ConsentBanner from '@visionmediahq/astro-consent/components/ConsentBanner.astro'")
  expect(wired).toMatch(/<ConsentBanner \/>\n\s*<VisionFooter \/>/)
})

test('wireFooter imports PrivacyLinks and renders it inside the footer with the neutral text colour', () => {
  const wired = wireFooter(FOOTER)
  expect(wired).toContain("import PrivacyLinks from '@visionmediahq/astro-consent/components/PrivacyLinks.astro'")
  expect(wired).toMatch(/<PrivacyLinks class="mt-2 text-neutral-content" \/>\n<\/footer>/)
})

test('every wire function is idempotent', () => {
  for (const [wire, source] of [
    [wireConfig, CONFIG],
    [wireCss, CSS],
    [wireBase, BASE],
    [wireFooter, FOOTER],
  ] as const) {
    const once = wire(source)
    expect(once).not.toBe(source)
    expect(wire(once)).toBe(once)
  }
})

test('a wire function throws a clear error when its anchor is missing', () => {
  expect(() => wireBase('---\n---\n<slot />')).toThrow(/anchor not found: <VisionFooter \/>/)
  expect(() => wireBase('no frontmatter')).toThrow(/anchor not found: ---/)
  expect(() => wireConfig('export default {}')).toThrow(/anchor not found/)
})
