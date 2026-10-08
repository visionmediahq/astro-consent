import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { App } from '../../../ci/rollout/coolify'
import {
  domainsFor,
  hasAstroDep,
  planPool,
  poolRepos,
  scanPool,
  statsLabels,
  type Exclusions,
  type OrgRepo,
  type PoolFile,
} from '../../../ci/rollout/pool'
import type { Report } from '../../../ci/rollout/types'

const app = (repo: string, fqdns: string[], branch = 'main'): App => ({
  uuid: `uuid-${repo}-${branch}`,
  name: repo,
  repo,
  branch,
  fqdns,
  autoDeploy: true,
})
const repo = (name: string, extra: Partial<OrgRepo> = {}): OrgRepo => ({ name, isArchived: false, astro: true, homepageUrl: null, ...extra })
const none: Exclusions = { pilot7: [], spamGuard: [] }

describe('exclusions.json', () => {
  test('lists the 7 pilot sites and the 10 spam-guard sites, jamtmaskin and eklimat included', () => {
    const ex = JSON.parse(readFileSync(join(import.meta.dirname, '../../../ci/rollout/exclusions.json'), 'utf8')) as Exclusions
    expect(ex.pilot7).toHaveLength(7)
    expect(ex.spamGuard).toHaveLength(10)
    expect(ex.spamGuard).toEqual(expect.arrayContaining(['jamtmaskin', 'eklimat']))
    expect(ex.pilot7).toContain('vasshallakatthotell')
  })
})

describe('statsLabels', () => {
  test('CASE domain mapping: every site label counts, enabled false included', () => {
    const yml = [
      'name: Exempel AB',
      'recipients:',
      '  - anna@example.se',
      'sites:',
      '  - label: exempel.se',
      '    umami:',
      '      - 00000000-0000-0000-0000-000000000000',
      '    enabled: true',
      "  - label: 'exempel-tva.se'   # retired in the stats, still live",
      '    umami: [x]',
      '    enabled: false',
      '  - umami: [y]',
      '    label: "Exempel-Tre.se"',
      '    enabled: false',
    ].join('\n')
    expect(statsLabels(yml)).toEqual(['exempel.se', 'exempel-tva.se', 'exempel-tre.se'])
  })

  test('a landingPages label is not a site label', () => {
    const yml = ['sites:', '  - label: a.se', '    plan: plus', '    landingPages:', '      - path: /kampanj/', '        label: Kampanj'].join('\n')
    expect(statsLabels(yml)).toEqual(['a.se'])
  })
})

describe('hasAstroDep', () => {
  test('astro in dependencies or devDependencies', () => {
    expect(hasAstroDep(JSON.stringify({ dependencies: { astro: '^6.0.0' } }))).toBe(true)
    expect(hasAstroDep(JSON.stringify({ devDependencies: { astro: '^5.0.0' } }))).toBe(true)
  })
  test('no astro, an @astrojs package alone, or unparseable JSON is false', () => {
    expect(hasAstroDep(JSON.stringify({ dependencies: { next: '15' } }))).toBe(false)
    expect(hasAstroDep(JSON.stringify({ dependencies: { '@astrojs/check': '1' } }))).toBe(false)
    expect(hasAstroDep('{ not json')).toBe(false)
  })
})

describe('domainsFor', () => {
  test('a Coolify app of the repo whose fqdn is a stats label gives that label (www ignored)', () => {
    const apps = [app('site', ['www.site.se', 'site.se']), app('other', ['other.se'])]
    expect(domainsFor(repo('site'), apps, ['site.se', 'other.se'])).toEqual(['site.se'])
  })

  test('an fqdn that is not in stats-config (a staging host) is not a domain', () => {
    expect(domainsFor(repo('site'), [app('site', ['site.vmedia.se'], 'staging')], ['site.se'])).toEqual([])
  })

  test('the GitHub homepage maps a repo that has no Coolify app', () => {
    expect(domainsFor(repo('site', { homepageUrl: 'https://www.site.se/' }), [], ['site.se'])).toEqual(['site.se'])
  })

  test('two apps on one repo: main-branch domains come first, each label once', () => {
    const apps = [app('nhrk', ['nhrk.vmedia.se'], 'production'), app('nhrk', ['nhrk.se', 'www.nhrk.se'])]
    expect(domainsFor(repo('nhrk', { homepageUrl: 'https://nhrk.se' }), apps, ['nhrk.vmedia.se', 'nhrk.se'])).toEqual(['nhrk.se', 'nhrk.vmedia.se'])
  })
})

describe('poolRepos', () => {
  const apps = [app('a', ['a.se']), app('b', ['b.se']), app('c', ['c.se']), app('d', ['d.se']), app('e', ['e.se']), app('f', ['f.se'])]
  const statsDomains = ['a.se', 'b.se', 'c.se', 'd.se', 'e.se']
  const orgRepos = [
    repo('e'),
    repo('a'),
    repo('b', { isArchived: true }),
    repo('c', { astro: false }),
    repo('d'),
    repo('f'),
    repo('g'),
    repo('nhrk'),
  ]
  const exclusions: Exclusions = { pilot7: ['nhrk', 'd'], spamGuard: ['e'] }

  test('CASE poolRepos: astro ∩ has a stats domain, minus exclusions, archived dropped, sorted', () => {
    expect(poolRepos({ orgRepos, statsDomains, exclusions, apps })).toEqual(['a'])
  })

  test('an Astro repo with no matching domain is unmatched, not pooled', () => {
    const plan = planPool({ orgRepos, statsDomains, exclusions, apps })
    expect(plan.repos).toEqual([{ repo: 'a', domains: ['a.se'] }])
    expect(plan.unmatched).toEqual(['f', 'g'])
  })

  test('with no exclusions every live Astro repo is pooled', () => {
    expect(poolRepos({ orgRepos, statsDomains, exclusions: none, apps })).toEqual(['a', 'd', 'e'])
  })
})

describe('scanPool', () => {
  const report = (site: string, domains: string[]) => ({ site, domains, classification: 'notice' }) as unknown as Report

  function fakes(failOn: string[] = []) {
    const events: string[] = []
    const saved: PoolFile[] = []
    return {
      events,
      saved,
      deps: {
        dirFor: (r: string) => `/work/pool/${r}`,
        clone: async (r: string, dir: string) => {
          events.push(`clone ${r}`)
          if (dir !== `/work/pool/${r}`) throw new Error(`wrong dir ${dir}`)
          if (failOn.includes(`clone:${r}`)) throw new Error(`clone of ${r} failed`)
        },
        detect: (dir: string, r: string, domains: string[]) => {
          events.push(`detect ${dir}`)
          if (failOn.includes(`detect:${r}`)) throw new Error('parse blew up')
          return report(r, domains)
        },
        remove: (dir: string) => {
          events.push(`rm ${dir}`)
        },
        save: (file: PoolFile) => {
          saved.push(structuredClone(file))
        },
      },
    }
  }
  const targets = [
    { repo: 'a', domains: ['a.se'] },
    { repo: 'b', domains: ['b.se'] },
    { repo: 'c', domains: ['c.se'] },
  ]

  test('one at a time: clone, detect, delete, save, in that order', async () => {
    const f = fakes()
    const out = await scanPool(targets, { rows: [], unmatched: ['z'] }, f.deps)
    expect(f.events).toEqual([
      'clone a', 'detect /work/pool/a', 'rm /work/pool/a',
      'clone b', 'detect /work/pool/b', 'rm /work/pool/b',
      'clone c', 'detect /work/pool/c', 'rm /work/pool/c',
    ])
    expect(out.rows.map((r) => [r.repo, r.domains, r.report?.site])).toEqual([
      ['a', ['a.se'], 'a'],
      ['b', ['b.se'], 'b'],
      ['c', ['c.se'], 'c'],
    ])
    expect(out.unmatched).toEqual(['z'])
    expect(f.saved).toHaveLength(3)
    expect(f.saved[0]!.rows).toHaveLength(1)
  })

  test('errors become rows with error and the clone is still deleted', async () => {
    const f = fakes(['detect:b', 'clone:c'])
    const out = await scanPool(targets, { rows: [], unmatched: [] }, f.deps)
    expect(out.rows[1]).toEqual({ repo: 'b', domains: ['b.se'], report: null, error: 'parse blew up' })
    expect(out.rows[2]).toEqual({ repo: 'c', domains: ['c.se'], report: null, error: 'clone of c failed' })
    expect(f.events).toContain('rm /work/pool/b')
    expect(f.events).toContain('rm /work/pool/c')
  })

  test('resumable: rows already in pool.json are skipped and kept', async () => {
    const f = fakes()
    const prior = { repo: 'b', domains: ['b.se'], report: report('b', ['b.se']) }
    const out = await scanPool(targets, { rows: [prior], unmatched: [] }, f.deps)
    expect(f.events.filter((e) => e.startsWith('clone'))).toEqual(['clone a', 'clone c'])
    expect(out.rows.map((r) => r.repo)).toEqual(['a', 'b', 'c'])
  })

  test('a row that ended in an error is scanned again on resume', async () => {
    const f = fakes()
    const failed = { repo: 'b', domains: ['b.se'], report: null, error: 'clone of b failed' }
    const out = await scanPool(targets, { rows: [failed], unmatched: [] }, f.deps)
    expect(f.events).toContain('clone b')
    expect(out.rows.find((r) => r.repo === 'b')?.error).toBeUndefined()
    expect(out.rows.map((r) => r.repo)).toEqual(['a', 'b', 'c'])
  })

  test('limit stops after N newly scanned repos', async () => {
    const f = fakes()
    const out = await scanPool(targets, { rows: [], unmatched: [] }, f.deps, { limit: 2 })
    expect(out.rows.map((r) => r.repo)).toEqual(['a', 'b'])
  })
})
