import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { REPO_ROOT } from '../../scripts/demo-copy'

// A site that imports the script API type-checks the package's raw source as part of its own
// program. That program has none of this repo's setup: no env.d.ts include and no @types/node.
const dir = mkdtempSync(join(tmpdir(), 'astro-consent-types-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('a site that imports the script API type-checks without this repo’s setup', { timeout: 120_000 }, () => {
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [], // no @types/node, as in a site that never installed it
        strict: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
      },
      files: ['site.ts'],
    }),
  )
  writeFileSync(
    join(dir, 'site.ts'),
    [
      `import { hasConsent, onConsent, openSettings } from '${REPO_ROOT}/src/client.ts'`,
      `onConsent('google-analytics', () => {})`,
      `const granted: boolean = hasConsent('external')`,
      `if (granted) openSettings()`,
      `window.umami?.track('cta_click', { label: 'x' })`,
      `const services: string[] = window.__vmConsent?.config.services ?? []`,
      `console.log(services)`,
    ].join('\n'),
  )
  const result = spawnSync(join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-p', dir], { encoding: 'utf8' })
  expect(result.stdout + result.stderr).toBe('')
  expect(result.status).toBe(0)
})
