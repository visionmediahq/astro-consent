import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

test('package.json has no script or field that makes npm build a git dependency', () => {
  const forbidden = ['prepare', 'preinstall', 'install', 'postinstall', 'prepack', 'build']
  for (const name of forbidden) expect(pkg.scripts).not.toHaveProperty(name)
  expect(pkg).not.toHaveProperty('workspaces')
})

test('package.json ships only src and services.json', () => {
  expect(pkg.files).toEqual(['src', 'services.json'])
})

test('exports cover the integration, the client, components and services.json', () => {
  expect(pkg.exports).toEqual({
    '.': './src/integration.ts',
    './client': './src/client.ts',
    './components/*': './src/components/*',
    './services.json': './services.json',
  })
})
