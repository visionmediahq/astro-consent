import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DEMO_DIR } from '../../scripts/demo-copy'
import { buildDemo, cleanupBuilds, type BuildResult } from './helpers'

const TIMEOUT = { timeout: 180_000 }

afterAll(cleanupBuilds)

function writePrivacy(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'src/data/privacy.json'), JSON.stringify(value))
}

describe('integration', () => {
  test('demo builds in consent mode and logs the mode', TIMEOUT, () => {
    const build = buildDemo('consent')
    expect(build.output).toMatch(/mode=consent/)
    expect(build.code).toBe(0)
  })

  test('demo builds in notice mode without the embed pages', TIMEOUT, () => {
    const build = buildDemo('notice')
    expect(build.output).toMatch(/mode=notice/)
    expect(build.code).toBe(0)
    expect(build.has('index.html')).toBe(true)
    expect(build.has('karta/index.html')).toBe(false)
  })

  test('the virtual config reaches a server component', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) => {
      writeFileSync(
        join(dir, 'src/pages/cfg.astro'),
        [
          '---',
          "import config from 'virtual:astro-consent/config'",
          'export const prerender = true',
          '---',
          '<html><head><title>cfg</title></head><body>',
          '<script type="application/json" id="cfg" set:html={JSON.stringify(config)} />',
          '</body></html>',
        ].join('\n'),
      )
    })
    expect(build.code).toBe(0)
    const config = JSON.parse(build.html('cfg/index.html').querySelector('#cfg')!.text)
    expect(config.consentVersion).toMatch(/^1:[0-9a-f]{6}$/)
    expect(config.site).toBe('demo.test')
    expect(config.services).toEqual(['google-maps', 'google-analytics'])
    expect(config.categories).toEqual(['necessary', 'external', 'statistics'])
  })

  test('the client script is injected on prerendered pages', TIMEOUT, () => {
    const build = buildDemo('consent')
    expect(build.code).toBe(0)
    const scripts = build.html('index.html').querySelectorAll('script[type="module"]')
    expect(scripts.length).toBeGreaterThan(0)
  })

  test('build fails on a missing privacy.json', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) => rmSync(join(dir, 'src/data/privacy.json')))
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/cannot read src\/data\/privacy\.json/)
  })

  test('build fails on invalid privacy.json and names the field', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) => writePrivacy(dir, { services: ['elfsight'] }))
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/privacy\.json → services/)
  })

  test('build fails on an unknown key in privacy.json', TIMEOUT, () => {
    const build = buildDemo('notice', (dir) => writePrivacy(dir, { services: [], has_banner: true }))
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/has_banner/)
  })

  test('build fails when log_endpoint is set and site is example.com', TIMEOUT, () => {
    const build = buildDemo('consent', undefined, { CONSENT_DEMO_SITE: 'https://example.com' })
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/log_endpoint/)
  })

  test('build fails when log_endpoint is set and site is unset', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) => {
      const path = join(dir, 'astro.config.ts')
      const config = readFileSync(path, 'utf8')
      const withoutSite = config.replace(/^\s*site: .*\n/m, '')
      expect(withoutSite).not.toBe(config)
      writeFileSync(path, withoutSite)
    })
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/log_endpoint/)
  })
})

const EMBED_IMPORT = "import ConsentEmbed from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'"

function page(frontmatter: string[], body: string): string {
  return ['---', EMBED_IMPORT, ...frontmatter, '---', '<html><head><title>t</title></head><body>', body, '</body></html>'].join('\n')
}

describe('build-time ConsentEmbed scan', () => {
  const BAD = '<ConsentEmbed service="meta-pixel" src="https://x.test" title="x" />'

  test('build fails on unknown ConsentEmbed service on an SSR page', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) => writeFileSync(join(dir, 'src/pages/bad.astro'), page([], BAD)))
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/bad\.astro/)
    expect(build.output).toMatch(/meta-pixel/)
    expect(build.output).toMatch(/privacy\.json/)
  })

  test('build fails on unknown ConsentEmbed service on a prerendered page', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) =>
      writeFileSync(join(dir, 'src/pages/bad.astro'), page(['export const prerender = true'], BAD)),
    )
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/bad\.astro/)
    expect(build.output).toMatch(/meta-pixel/)
  })

  test('build fails on unknown ConsentEmbed service inside a component', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) => {
      writeFileSync(join(dir, 'src/Map.astro'), ['---', EMBED_IMPORT, '---', BAD].join('\n'))
      writeFileSync(
        join(dir, 'src/pages/uses-map.astro'),
        ['---', "import Map from '../Map.astro'", '---', '<html><head><title>t</title></head><body><Map /></body></html>'].join('\n'),
      )
    })
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/Map\.astro/)
    expect(build.output).toMatch(/meta-pixel/)
  })

  test('build fails on unknown service in an embed imported under another name', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) =>
      writeFileSync(
        join(dir, 'src/pages/alias.astro'),
        [
          '---',
          "import Karta from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'",
          '---',
          '<html><head><title>t</title></head><body>',
          '<Karta title="A > B" service="meta-pixel" src="https://x.test" />',
          '</body></html>',
        ].join('\n'),
      ),
    )
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/alias\.astro/)
    expect(build.output).toMatch(/meta-pixel/)
    expect(build.output).toMatch(/privacy\.json/)
  })

  test('a commented-out embed does not fail the build', TIMEOUT, () => {
    // A technician removes a map: comments the embed out and drops the service from privacy.json.
    const build = buildDemo('notice', (dir) =>
      writeFileSync(
        join(dir, 'src/pages/removed-map.astro'),
        [
          '---',
          EMBED_IMPORT,
          '// was: <ConsentEmbed service="google-maps" src="https://x.test" title="Karta" />',
          '---',
          '<html><head><title>t</title></head><body>',
          '<!-- <ConsentEmbed service="google-maps" src="https://x.test" title="Karta" /> -->',
          '{/* <ConsentEmbed service="google-maps" src="https://x.test" title="Karta" /> */}',
          '<p>Kartan är borttagen.</p>',
          '</body></html>',
        ].join('\n'),
      ),
    )
    expect(build.output).not.toMatch(/is not listed in/)
    expect(build.code).toBe(0)
  })

  test('an embed commented out inside a .map() does not fail the build', TIMEOUT, () => {
    const build = buildDemo('notice', (dir) =>
      writeFileSync(
        join(dir, 'src/pages/removed-in-map.astro'),
        [
          '---',
          EMBED_IMPORT,
          "const places = ['a', 'b']",
          '---',
          '<html><head><title>t</title></head><body>',
          '{places.map((place) => (',
          '  // <ConsentEmbed service="google-maps" src="https://x.test" title="Karta" />',
          '  <p>{place}</p>',
          '))}',
          '{places.length > 5 && (/* <ConsentEmbed service="google-maps" src="https://x.test" title="Karta" /> */ <p>många</p>)}',
          '<p>{"<ConsentEmbed service=\'google-maps\' />"}</p>',
          '</body></html>',
        ].join('\n'),
      ),
    )
    expect(build.output).not.toMatch(/is not listed in/)
    expect(build.code).toBe(0)
  })

  test('an embed in notice mode fails the build', TIMEOUT, () => {
    const build = buildDemo('notice', (dir) =>
      copyFileSync(join(DEMO_DIR, 'src/pages/karta.astro'), join(dir, 'src/pages/karta.astro')),
    )
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/karta\.astro/)
    expect(build.output).toMatch(/google-maps/)
  })

  test('a non-literal service prop passes the scan', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) =>
      writeFileSync(
        join(dir, 'src/pages/dynamic.astro'),
        page(['export const prerender = true'], `<ConsentEmbed service={'google-maps'} src="https://x.test" title="x" />`),
      ),
    )
    expect(build.code).toBe(0)
  })

  test('a non-literal unknown service fails a prerendered page at render', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) =>
      writeFileSync(
        join(dir, 'src/pages/dynamic.astro'),
        page(['export const prerender = true'], `<ConsentEmbed service={'meta-pixel'} src="https://x.test" title="x" />`),
      ),
    )
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/meta-pixel/)
  })

  test('an unused .astro file with a bad service does not fail the build', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) =>
      writeFileSync(join(dir, 'src/Unused.astro'), ['---', EMBED_IMPORT, '---', BAD].join('\n')),
    )
    expect(build.code).toBe(0)
  })
})

describe('banner and footer markup', () => {
  let consentBuild: BuildResult
  let noticeBuild: BuildResult

  beforeAll(() => {
    consentBuild = buildDemo('consent')
    noticeBuild = buildDemo('notice')
  }, 360_000)

  test('consent banner markup: hidden, three actions in one row, no pre-ticked toggle', () => {
    expect(consentBuild.code).toBe(0)
    const banner = consentBuild.html('index.html').querySelector('section[data-consent-banner]')!
    expect(banner.hasAttribute('hidden')).toBe(true)
    expect(banner.getAttribute('data-mode')).toBe('consent')
    expect(banner.getAttribute('data-view')).toBe('main')

    const action = (name: string) => banner.querySelector(`[data-consent-action="${name}"]`)!
    const [settings, none, all] = [action('settings'), action('none'), action('all')]
    expect(none.parentNode).toBe(all.parentNode)
    expect(settings.parentNode).toBe(all.parentNode)
    for (const button of [none, all]) {
      expect(button.classList.contains('btn')).toBe(true)
      expect(button.classList.contains('btn-sm')).toBe(true)
    }
    expect(none.getAttribute('class')).toBe(all.getAttribute('class'))

    const checked = banner.querySelectorAll('input').filter((input) => input.hasAttribute('checked'))
    expect(checked.map((input) => input.getAttribute('name'))).toEqual(['necessary'])
    expect(checked[0]!.hasAttribute('disabled')).toBe(true)

    const categories = banner.querySelectorAll('[data-consent-category]').map((el) => el.getAttribute('data-consent-category'))
    expect(categories).toEqual(['necessary', 'external', 'statistics'])
    expect(banner.querySelector('form[data-consent-settings]')!.hasAttribute('hidden')).toBe(true)
    expect(banner.querySelector('[data-consent-main]')!.hasAttribute('hidden')).toBe(false)
  })

  test('service rows are rendered hidden for each configured service', () => {
    const banner = consentBuild.html('index.html').querySelector('[data-consent-banner]')!
    for (const slug of ['google-maps', 'google-analytics']) {
      const row = banner.querySelector(`[data-consent-service="${slug}"]`)!
      expect(row.hasAttribute('hidden')).toBe(true)
      expect(row.querySelector(`input[name="service:${slug}"]`)).not.toBeNull()
    }
    expect(banner.querySelector('[data-consent-category="external"] [data-consent-service="google-maps"]')).not.toBeNull()
  })

  test('notice banner markup has only OK', () => {
    expect(noticeBuild.code).toBe(0)
    const banner = noticeBuild.html('index.html').querySelector('section[data-consent-banner]')!
    expect(banner.getAttribute('data-mode')).toBe('notice')
    const actions = banner.querySelectorAll('[data-consent-action]')
    expect(actions.map((el) => el.getAttribute('data-consent-action'))).toEqual(['notice_ok'])
    expect(banner.querySelector('form')).toBeNull()
  })

  test('policy link appears only when policy_url is set', () => {
    const consentPage = consentBuild.html('index.html')
    const href = 'a[href="https://demo.test/integritet"]'
    expect(consentPage.querySelector(`[data-consent-banner] ${href}`)).not.toBeNull()
    expect(consentPage.querySelector(`[data-privacy-links] ${href}`)).not.toBeNull()
    expect(consentPage.querySelector('[data-privacy-links] [data-consent-open]')).not.toBeNull()
    const noticePage = noticeBuild.html('index.html')
    expect(noticePage.querySelectorAll('[data-consent-banner] a')).toHaveLength(0)
    expect(noticePage.querySelectorAll('[data-privacy-links] a')).toHaveLength(0)
    expect(noticePage.querySelector('[data-privacy-links] [data-consent-open]')).not.toBeNull()
  })

  test('the banner still carries card-actions', () => {
    expect(consentBuild.html('index.html').querySelector('[data-consent-banner] .card-actions')).not.toBeNull()
    expect(noticeBuild.html('index.html').querySelector('[data-consent-banner] .card-actions')).not.toBeNull()
  })

  test('no DaisyUI 4-only classes', () => {
    expect(consentBuild.html('index.html').querySelector('.form-control')).toBeNull()
  })
})
