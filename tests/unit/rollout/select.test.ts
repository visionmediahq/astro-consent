import { describe, expect, it } from 'vitest'
import { drawOrder, fisherYates, mulberry32, slots, strata } from '../../../ci/rollout/select'
import type { IframeInfo, PoolRow, Report } from '../../../ci/rollout/types'

const iframe = (host: string, srcKind: IframeInfo['srcKind'] = 'literal'): IframeInfo => ({
  file: 'a.astro',
  start: 0,
  end: 1,
  srcKind,
  src: null,
  host,
  service: host.includes('google') ? 'google-maps' : null,
  title: null,
  classes: null,
  height: null,
  style: null,
})

const row = (
  repo: string,
  o: { maps?: boolean; widget?: boolean; unresolved?: boolean; banners?: string[]; classification?: Report['classification']; report?: null } = {},
): PoolRow => {
  if (o.report === null) return { repo, domains: [], report: null, error: 'boom' }
  const report = {
    classification: o.classification ?? (o.maps ? 'consent' : 'notice'),
    iframes: o.maps ? [iframe('www.google.com', o.unresolved ? 'unresolved' : 'literal')] : [],
    widgets: o.widget ? [{ service: 'elfsight' }] : [],
    banners: o.banners ?? [],
    reasons: [],
  } as unknown as Report
  return { repo, domains: [`${repo}.se`], report }
}

const many = (prefix: string, n: number, maps: boolean): PoolRow[] =>
  Array.from({ length: n }, (_, i) => row(`${prefix}-${String(i).padStart(3, '0')}`, { maps }))

describe('mulberry32', () => {
  it('matches the reference outputs for 20261006', () => {
    const r = mulberry32(20261006)
    expect([r(), r(), r()]).toEqual([0.8267591667827219, 0.08045424590818584, 0.5557971422094852])
  })
})

describe('fisherYates', () => {
  it('returns a permutation and leaves the input alone', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8]
    const out = fisherYates(xs, mulberry32(1))
    expect(xs).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...out].sort()).toEqual(xs)
  })
})

describe('strata', () => {
  it('puts a row with widgets only in consent', () => {
    expect(strata([row('w', { widget: true })]).consent.map((x) => x.repo)).toEqual(['w'])
  })
  it('puts a row with an unresolved maps iframe in consent', () => {
    expect(strata([row('u', { maps: true, unresolved: true })]).consent.map((x) => x.repo)).toEqual(['u'])
  })
  it('puts a needs-human row with a maps iframe in consent', () => {
    const r = row('a', { maps: true, classification: 'needs-human' })
    expect(strata([r]).consent.map((x) => x.repo)).toEqual(['a'])
  })
  it('puts a GA-only site in notice', () => {
    expect(strata([row('b')]).notice.map((x) => x.repo)).toEqual(['b'])
  })
  it('excludes rows with banners and rows with no report', () => {
    const rows = [
      row('c', { banners: ['cookiebot'] }),
      row('d', { maps: true, banners: ['elfsight'] }),
      row('e', { report: null }),
    ]
    expect(strata(rows)).toEqual({ consent: [], notice: [] })
  })
})

describe('slots', () => {
  it('gives ties to consent', () => {
    expect(slots({ consent: 1, notice: 1 }, 3)).toEqual({ consent: 2, notice: 1 })
  })
  it('uses largest remainder', () => {
    expect(slots({ consent: 40, notice: 140 })).toEqual({ consent: 3, notice: 12 })
  })
  it('gives a tiny stratum no minimum', () => {
    expect(slots({ consent: 1, notice: 179 })).toEqual({ consent: 0, notice: 15 })
  })
  it('handles an empty pool', () => {
    expect(slots({ consent: 0, notice: 0 })).toEqual({ consent: 0, notice: 0 })
  })
})

describe('drawOrder', () => {
  const maps = many('m', 20, true)
  const notice = many('n', 30, false)
  it('is independent of the other stratum', () => {
    expect(drawOrder([...maps, ...notice], 20261006).consent).toEqual(drawOrder(maps, 20261006).consent)
  })
  it('does not depend on input order', () => {
    const a = drawOrder([...maps, ...notice], 20261006)
    const b = drawOrder([...notice, ...maps].reverse(), 20261006)
    expect(b).toEqual(a)
  })
  it('lists each drawable repo once and skips banner rows', () => {
    const out = drawOrder([...maps, ...notice, row('x', { banners: ['cookiebot'] })], 20261006)
    expect([...out.consent].sort()).toEqual(maps.map((r) => r.repo))
    expect([...out.notice].sort()).toEqual(notice.map((r) => r.repo))
  })
})
