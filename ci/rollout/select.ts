// Seeded stratified draw of the rollout batch from pool.json (spec D.2, D.3).
//
//   tsx ci/rollout/select.ts --pool <pool.json> [--total 15]
//
// Prints, per stratum, the size, the slot count and the full shuffled order (repo names only).
// It builds and clones nothing: candidates are built by hand, in this order, until the slots are
// filled. pool.json holds client data and is never committed.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { normaliseReport } from './lib/report'
import type { PoolRow } from './types'

export const SEED = 20261006

export type Stratum = 'consent' | 'notice'

export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates from the end; returns a new array. */
export function fisherYates<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i] as T
    out[i] = out[j] as T
    out[j] = tmp
  }
  return out
}

/**
 * Drawable rows split into strata. `consent` is any iframe with a registered service (whatever its
 * srcKind or the row's classification) or any widget; `notice` is the rest. Rows with no report
 * (scan errors) and rows with an existing banner are not drawable.
 */
export function strata(rows: readonly PoolRow[]): { consent: PoolRow[]; notice: PoolRow[] } {
  const out: { consent: PoolRow[]; notice: PoolRow[] } = { consent: [], notice: [] }
  for (const row of rows) {
    const report = row.report
    if (!report || report.banners.length > 0) continue
    const isConsent = report.iframes.some((f) => f.service !== null) || report.widgets.length > 0
    out[isConsent ? 'consent' : 'notice'].push(row)
  }
  return out
}

/** Largest remainder; ties go to consent. No minimum per stratum. */
export function slots(sizes: { consent: number; notice: number }, total = 15): { consent: number; notice: number } {
  const all = sizes.consent + sizes.notice
  if (all === 0) return { consent: 0, notice: 0 }
  const exact = { consent: (sizes.consent * total) / all, notice: (sizes.notice * total) / all }
  const out = { consent: Math.floor(exact.consent), notice: Math.floor(exact.notice) }
  let left = total - out.consent - out.notice
  const order: Stratum[] =
    exact.consent - out.consent >= exact.notice - out.notice ? ['consent', 'notice'] : ['notice', 'consent']
  for (let i = 0; left > 0; i++, left--) out[order[i % 2]!]++
  return out
}

const byRepo = (a: PoolRow, b: PoolRow): number => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)

/** Shuffled repo names per stratum: `mulberry32(seed + i)`, i = 0 for consent and 1 for notice. */
export function drawOrder(rows: readonly PoolRow[], seed: number): { consent: string[]; notice: string[] } {
  const s = strata(rows)
  const order = (list: PoolRow[], i: number): string[] =>
    fisherYates([...list].sort(byRepo), mulberry32(seed + i)).map((r) => r.repo)
  return { consent: order(s.consent, 0), notice: order(s.notice, 1) }
}

function main(argv: string[]): void {
  let pool: string | undefined
  let total = 15
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pool') pool = argv[++i]
    else if (argv[i] === '--total') total = Number(argv[++i])
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!pool) throw new Error('usage: select.ts --pool <pool.json> [--total 15]')
  const rows = (JSON.parse(readFileSync(pool, 'utf8')) as { rows: PoolRow[] }).rows.map((r) => (r.report ? { ...r, report: normaliseReport(r.report) } : r))
  const order = drawOrder(rows, SEED)
  const n = slots({ consent: order.consent.length, notice: order.notice.length }, total)
  const lines = [`seed ${SEED}, ${rows.length} rows`]
  for (const k of ['consent', 'notice'] as const) {
    lines.push('', `${k}: size ${order[k].length}, slots ${n[k]}`, ...order[k].map((r, i) => `  ${i + 1}. ${r}`))
  }
  const errors = rows.filter((r) => !r.report).map((r) => r.repo)
  lines.push('', `not drawable (no report): ${errors.length}`, ...errors.map((r) => `  ${r}`))
  console.log(lines.join('\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
