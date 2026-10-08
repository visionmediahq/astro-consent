import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ALLOWLIST, diffLock, diffPackageJson, majorOf } from '../../../ci/rollout/lib/lockfile'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const lock = (site: string, side: 'before' | 'merged'): string =>
  readFileSync(join(FIXTURES, site, side, 'package-lock.json.txt'), 'utf8')

const PKG = '@visionmediahq/astro-consent'

type Packages = Record<string, Record<string, unknown>>
const v3 = (packages: Packages) => ({ lockfileVersion: 3, packages })
const entry = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`,
  integrity: `sha512-${version}`,
  ...extra,
})

describe('majorOf', () => {
  test('astro from a v3 lockfile', () => {
    expect(majorOf(lock('a-tak', 'before'), 'astro')).toBe(6)
  })

  test('a scoped package, a parsed object and a missing package', () => {
    expect(majorOf(lock('a-tak', 'merged'), PKG)).toBe(1)
    expect(majorOf(v3({ 'node_modules/daisyui': entry('5.5.19') }), 'daisyui')).toBe(5)
    expect(majorOf(v3({}), 'tailwindcss')).toBeNull()
  })

  test('a v1 lockfile', () => {
    expect(majorOf({ lockfileVersion: 1, dependencies: { astro: { version: '4.16.1' } } }, 'astro')).toBe(4)
  })
})

describe('diffLock', () => {
  test('ALLOWLIST names zod and lightningcss', () => {
    expect(ALLOWLIST.map((r) => r.name)).toEqual(expect.arrayContaining(['zod', 'lightningcss']))
  })

  test('zod within major 4 is allowed', () => {
    const d = diffLock(v3({ 'node_modules/zod': entry('4.1.0') }), v3({ 'node_modules/zod': entry('4.6.5') }), PKG)
    expect(d.unknown).toEqual([])
    expect(d.allowed).toEqual([expect.stringContaining('node_modules/zod')])
  })

  test('zod 4 → 5 is unknown', () => {
    const d = diffLock(v3({ 'node_modules/zod': entry('4.1.0') }), v3({ 'node_modules/zod': entry('5.0.0') }), PKG)
    expect(d.allowed).toEqual([])
    expect(d.unknown).toEqual([expect.stringContaining('node_modules/zod')])
  })

  test('zod moving within 3.x is unknown: the rule covers 4.x only (spec C3.1)', () => {
    const d = diffLock(v3({ 'node_modules/zod': entry('3.22.0') }), v3({ 'node_modules/zod': entry('3.25.0') }), PKG)
    expect(d.allowed).toEqual([])
    expect(d.unknown).toEqual([expect.stringContaining('node_modules/zod')])
  })

  test('a zod- package does not inherit the zod rule', () => {
    const d = diffLock(
      v3({ 'node_modules/zod-validation-error': entry('4.0.0') }),
      v3({ 'node_modules/zod-validation-error': entry('4.0.2') }),
      PKG,
    )
    expect(d.allowed).toEqual([])
    expect(d.unknown).toEqual([expect.stringContaining('node_modules/zod-validation-error')])
  })

  test('a lightningcss- package that is not a platform build is unknown', () => {
    const d = diffLock(
      v3({ 'node_modules/lightningcss-loader': entry('2.0.0', { dev: true }) }),
      v3({ 'node_modules/lightningcss-loader': entry('2.0.0') }),
      PKG,
    )
    expect(d.unknown).toEqual([expect.stringContaining('node_modules/lightningcss-loader')])
  })

  test('removing the astro-consent entry is unknown', () => {
    const d = diffLock(v3({ [`node_modules/${PKG}`]: { version: '1.0.1' } }), v3({}), PKG)
    expect(d.allowed).toEqual([])
    expect(d.unknown).toEqual([expect.stringContaining(PKG)])
  })

  test('lightningcss losing dev: true is allowed', () => {
    const d = diffLock(
      v3({
        'node_modules/lightningcss': entry('1.30.2', { dev: true }),
        'node_modules/lightningcss-darwin-arm64': entry('1.30.2', { dev: true, optional: true }),
      }),
      v3({
        'node_modules/lightningcss': entry('1.30.2'),
        'node_modules/lightningcss-darwin-arm64': entry('1.30.2', { optional: true }),
      }),
      PKG,
    )
    expect(d.unknown).toEqual([])
    expect(d.allowed).toHaveLength(2)
  })

  test('another package losing dev: true is unknown', () => {
    const d = diffLock(v3({ 'node_modules/vite': entry('7.0.0', { dev: true }) }), v3({ 'node_modules/vite': entry('7.0.0') }), PKG)
    expect(d.unknown).toEqual([expect.stringContaining('node_modules/vite')])
  })

  test('a new unrelated package is unknown; a removed package is unknown', () => {
    const d = diffLock(
      v3({ 'node_modules/left-pad': entry('1.0.0') }),
      v3({ 'node_modules/is-odd': entry('3.0.1') }),
      PKG,
    )
    expect(d.allowed).toEqual([])
    expect(d.unknown).toEqual([
      expect.stringContaining('node_modules/is-odd'),
      expect.stringContaining('node_modules/left-pad'),
    ])
  })

  test('the astro-consent entry, its nested zod and the root dependency are allowed', () => {
    const d = diffLock(
      v3({ '': { name: 'site', dependencies: { astro: '^6.1.6' } } }),
      v3({
        '': { name: 'site', dependencies: { [PKG]: 'github:visionmediahq/astro-consent#semver:^1.0.2', astro: '^6.1.6' } },
        [`node_modules/${PKG}`]: { version: '1.0.2', resolved: 'git+ssh://git@github.com/visionmediahq/astro-consent.git#abc' },
        [`node_modules/${PKG}/node_modules/zod`]: entry('4.6.5'),
      }),
      PKG,
    )
    expect(d.unknown).toEqual([])
    expect(d.allowed).toHaveLength(3)
  })

  test('any other change to the root entry is unknown', () => {
    const d = diffLock(
      v3({ '': { name: 'site', dependencies: {} } }),
      v3({ '': { name: 'site', dependencies: { [PKG]: '^1.0.2', react: '^19.0.0' } } }),
      PKG,
    )
    expect(d.unknown).toEqual([expect.stringContaining('root')])
  })

  test('the root engines catching up with package.json is allowed (stale lockfile on main, mannature)', () => {
    const d = diffLock(
      v3({ '': { name: 'site', dependencies: {}, engines: { node: '>=22.0.0' } } }),
      v3({ '': { name: 'site', dependencies: { [PKG]: '^1.0.2' }, engines: { node: '>=22.12.0' } } }),
      PKG,
      { engines: { node: '>=22.12.0' } },
    )
    expect(d.unknown).toEqual([])
    expect(d.allowed).toEqual([`(root): dependency on ${PKG}; engines synced to package.json ({"node":">=22.0.0"} → {"node":">=22.12.0"})`])
  })

  test('a root engines change that does not match package.json, or without package.json, is unknown', () => {
    const before = v3({ '': { name: 'site', dependencies: {}, engines: { node: '>=22.0.0' } } })
    const after = v3({ '': { name: 'site', dependencies: { [PKG]: '^1.0.2' }, engines: { node: '>=22.12.0' } } })
    expect(diffLock(before, after, PKG, { engines: { node: '>=24.0.0' } }).unknown).toEqual(['(root): engines changed'])
    expect(diffLock(before, after, PKG).unknown).toEqual(['(root): engines changed'])
    // Dropped from the lockfile while package.json has none: still a sync, but never with a missing package.json value.
    const dropped = v3({ '': { name: 'site', dependencies: { [PKG]: '^1.0.2' } } })
    expect(diffLock(before, dropped, PKG, { engines: undefined }).unknown).toEqual(['(root): engines changed'])
  })

  test('an engines sync does not hide another root change', () => {
    const d = diffLock(
      v3({ '': { name: 'site', dependencies: {}, engines: { node: '>=22.0.0' } } }),
      v3({ '': { name: 'site', dependencies: { [PKG]: '^1.0.2', react: '^19.0.0' }, engines: { node: '>=22.12.0' } } }),
      PKG,
      { engines: { node: '>=22.12.0' } },
    )
    expect(d.unknown).toEqual(['(root): dependencies, engines changed'])
  })

  test('npm re-sorting the root dependencies is not a change (spec C3.1)', () => {
    const d = diffLock(
      v3({ '': { name: 'site', dependencies: { astro: '^7.0.0', '@lucide/astro': '^1.0.0' } } }),
      v3({ '': { name: 'site', dependencies: { '@lucide/astro': '^1.0.0', [PKG]: '^1.0.2', astro: '^7.0.0' } } }),
      PKG,
    )
    expect(d.unknown).toEqual([])
    expect(d.allowed).toEqual([expect.stringContaining('root')])
  })

  test('every pilot fixture before → merged is fully allowed', () => {
    for (const site of ['a-tak', 'aspomad', 'domeijstapetserarverkstad', 'munkforstradgardstjanst', 'nhrk', 'traforadling', 'vasshallakatthotell']) {
      const d = diffLock(lock(site, 'before'), lock(site, 'merged'), PKG)
      expect(d.unknown, site).toEqual([])
      expect(d.allowed.length, site).toBeGreaterThan(0)
    }
  })
})

describe('diffPackageJson', () => {
  const before = JSON.stringify({ name: 'site', scripts: { build: 'astro build' }, dependencies: { astro: '^7.0.0', '@lucide/astro': '^1.0.0' } })

  test('adding the package, re-sorted, is the only allowed change', () => {
    const after = JSON.stringify({ scripts: { build: 'astro build' }, name: 'site', dependencies: { '@lucide/astro': '^1.0.0', [PKG]: 'github:visionmediahq/astro-consent#semver:^1.0.2', astro: '^7.0.0' } })
    expect(diffPackageJson(before, after, PKG)).toEqual([])
  })

  test('any other change is listed: scripts, overrides, another dependency, a missing package', () => {
    const after = JSON.stringify({
      name: 'site',
      scripts: { build: 'astro build', postinstall: 'x' },
      overrides: { vite: '7.0.0' },
      dependencies: { astro: '^7.1.0', '@lucide/astro': '^1.0.0', [PKG]: '^1.0.2' },
    })
    expect(diffPackageJson(before, after, PKG)).toEqual([
      expect.stringContaining('dependencies.astro'),
      expect.stringContaining('overrides'),
      expect.stringContaining('scripts'),
    ])
    expect(diffPackageJson(before, before, PKG)).toEqual([expect.stringContaining(PKG)])
  })

  test('npm dropping an empty dependency map is not a change (antonicommunications); emptying one is', () => {
    const withEmpty = JSON.stringify({ ...JSON.parse(before), devDependencies: {} })
    const after = JSON.stringify({ ...JSON.parse(before), dependencies: { ...JSON.parse(before).dependencies, [PKG]: '^1.0.2' } })
    expect(diffPackageJson(withEmpty, after, PKG)).toEqual([])
    const withDev = JSON.stringify({ ...JSON.parse(before), devDependencies: { prettier: '^3.0.0' } })
    expect(diffPackageJson(withDev, after, PKG)).toEqual(['devDependencies: changed'])
    // Only the dependency maps: an empty `overrides` that goes away is still a change.
    expect(diffPackageJson(JSON.stringify({ ...JSON.parse(before), overrides: {} }), after, PKG)).toEqual(['overrides: changed'])
  })
})
