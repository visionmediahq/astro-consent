// Self-hosts Sentry's browser bundle (#93), from what detect found (`report.sentry`, status `wire`):
// the layouts that load it from jsDelivr (a 404) or browser.sentry-cdn.com load it from the site.
//
// planSentry works everything out before anything is written, the text edits first (no request is
// made when they refuse), then the bundle: fetched once from Sentry's CDN at the pinned version
// (lib/sentry.ts) and refused unless it hashes to the SRI Sentry publishes for it. The plan is:
//   - public/js/sentry-<version>.min.js, the bytes Sentry serves;
//   - each loader's URL replaced by /js/sentry-<version>.min.js, and its integrity and crossorigin
//     (attributes, or the `x.integrity = …` / `x.crossOrigin = …` lines) cut: they were for the CDN;
//   - each preconnect or dns-prefetch link to the CDNs (`report.sentry.hints`) cut, as whole lines.
// Every other attribute stays: defer, async, onload and the order of the scripts are what make
// `Sentry.init` run after the bundle, and they work the same from the site's own origin.
// The report must still match a fresh detect (its offsets are where the edits go).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { detectSentry } from '../detect/sentry'
import { SENTRY_CDN_FILE, SENTRY_FILE, SENTRY_SRC, SENTRY_SRI, SENTRY_VERSION } from '../lib/sentry'
import type { SiteFiles } from '../lib/site-files'
import type { Edit, SentryInfo, SentryPlan } from '../types'
import { applyEdits } from './engine'
import { type FontFetch, httpFetch } from './fonts-host'
import { commitAllowed, recovery, startBranch, writeFiles } from './index'

export const SENTRY_BRANCH = 'sentry-selfhost'
export const SENTRY_COMMIT_MESSAGE = 'feat: Sentry-bundlen för felrapportering från sajten själv (self-hosted)'
const TARGET = 'sentry bundle'

/** The SRI form of `bytes`' SHA-384 (`sha384-<base64>`). */
export const sri384 = (bytes: Uint8Array): string => `sha384-${createHash('sha384').update(bytes).digest('base64')}`

/**
 * The pinned bundle from Sentry's CDN, refused (thrown) unless it answers 200 and hashes to `sri`
 * (the published SENTRY_SRI; a test passes its own).
 */
export async function fetchSentryBundle(fetch: FontFetch = httpFetch, sri: string = SENTRY_SRI): Promise<Uint8Array> {
  let res: Awaited<ReturnType<FontFetch>>
  try {
    res = await fetch(SENTRY_CDN_FILE, {})
  } catch (e) {
    throw new Error(`${SENTRY_CDN_FILE} failed: ${(e as Error).message}`)
  }
  if (res.status !== 200) throw new Error(`${SENTRY_CDN_FILE} answered ${res.status}`)
  const got = sri384(res.body)
  if (got !== sri) throw new Error(`${SENTRY_CDN_FILE} hashes to ${got}, not the recorded ${sri}: nothing written`)
  return res.body
}

export interface SentryInput {
  /** Missing in reports stored before Sentry detection. */
  sentry?: SentryInfo
}

/** The text edits: each loader's URL to the local src, its CDN-only attributes or lines cut, each hint cut. */
export function sentryEdits(info: SentryInfo): Edit[] {
  return [
    ...info.loaders.flatMap((l) => [
      { file: l.file, start: l.src.start, end: l.src.end, text: SENTRY_SRC, target: `${TARGET} src (${l.file}:${l.line})` },
      ...l.cuts.map((c) => ({ file: l.file, start: c.start, end: c.end, text: '', target: `${TARGET} ${c.what} (${l.file}:${l.line})` })),
    ]),
    ...(info.hints ?? []).map((h) => ({ file: h.file, start: h.start, end: h.end, text: '', target: `${TARGET} ${h.rel} ${h.host} (${h.file}:${h.line})` })),
  ]
}

/** The plan, or refusals. Nothing is written; see the header for what it holds. */
export async function planSentry(files: SiteFiles, report: SentryInput, opts: { bundle?: () => Promise<Uint8Array> } = {}): Promise<SentryPlan> {
  const refuse = (reason: string): SentryPlan => ({ ok: false, refusals: [{ file: '', target: TARGET, reason }] })
  const info = report.sentry
  if (!info) return refuse('the report was stored before Sentry detection: run detect again')
  if (info.status === 'needs-human') return { ok: false, refusals: info.reasons.map((r) => ({ file: '', target: TARGET, reason: `needs a look: ${r}` })) }
  if (info.status !== 'wire' || info.loaders.length === 0) return refuse(`no Sentry CDN load to self-host (status ${info.status})`)
  if (files.exists(SENTRY_FILE)) return refuse(`${SENTRY_FILE} already exists`)
  // The edits go at the report's offsets, so only the files detect read can take them.
  let fresh: SentryInfo
  try {
    fresh = detectSentry(files)
  } catch (e) {
    return refuse(`detect failed on the checkout: ${(e as Error).message}`)
  }
  if (!isDeepStrictEqual(fresh, info)) return refuse('report.sentry no longer matches the checkout: run detect again')
  const edits = sentryEdits(info)
  try {
    for (const file of new Set(edits.map((e) => e.file))) applyEdits(files.read(file), edits.filter((e) => e.file === file))
  } catch (e) {
    return refuse((e as Error).message)
  }
  let bytes: Uint8Array
  try {
    bytes = await (opts.bundle ?? (() => fetchSentryBundle()))()
  } catch (e) {
    return refuse((e as Error).message)
  }
  const from = [...new Set(info.loaders.map((l) => `${l.cdn === 'jsdelivr' ? 'cdn.jsdelivr.net' : 'browser.sentry-cdn.com'} ${l.version}`))].join(', ')
  return {
    ok: true,
    edits,
    file: { path: SENTRY_FILE, bytes },
    notes: [
      `sentry: ${info.loaders.length} load(s) of the bundle from ${from} → ${SENTRY_SRC} (${SENTRY_VERSION}), in ${[...new Set(info.loaders.map((l) => `${l.file}:${l.line}`))].join(', ')}`,
      `sentry: ${SENTRY_FILE}, ${bytes.length} bytes, ${SENTRY_SRI}`,
      ...(info.hints.length ? [`sentry: ${info.hints.length} resource hint(s) to the CDN cut (${info.hints.map((h) => `${h.rel} ${h.host}, ${h.file}:${h.line}`).join('; ')})`] : []),
      ...(info.loaders.some((l) => l.initBeforeBundle)
        ? [`sentry: NOTE Sentry.init runs before the async/defer bundle in ${info.loaders.filter((l) => l.initBeforeBundle).map((l) => `${l.file}:${l.line}`).join(', ')}: error reporting stays off even with a DSN (left as it is, #93 follow-up)`]
        : []),
    ],
  }
}

/** A file the Sentry plan writes: `before` is null for the bundle; `after` its bytes. */
export interface SentryFile {
  path: string
  before: string | null
  after: string | Uint8Array
}

/**
 * Each file the plan writes, from the files as detect read them (`read`). `base` are edits applied
 * in the same files before (the banner's and the fonts', for the last commit on consent-banner):
 * a file's `before` is then theirs, its `after` all together. Throws on overlap.
 */
export function sentryFiles(read: (path: string) => string, plan: Extract<SentryPlan, { ok: true }>, base: readonly Edit[] = []): SentryFile[] {
  const out: SentryFile[] = []
  for (const path of [...new Set(plan.edits.map((e) => e.file))]) {
    const original = read(path)
    const theirs = base.filter((e) => e.file === path)
    out.push({ path, before: applyEdits(original, theirs), after: applyEdits(original, [...theirs, ...plan.edits.filter((e) => e.file === path)]) })
  }
  out.push({ path: plan.file.path, before: null, after: plan.file.bytes })
  return out
}

/**
 * Writes `files` and commits them alone (SENTRY_COMMIT_MESSAGE). With `branch`, first switches to a
 * new branch from origin/main (startBranch's checks). With `onto`, the commit goes on top of that
 * branch's commits (wire: the banner, and the fonts when they were self-hosted). Every edited file
 * must still be on disk as planned (`before`), and the bundle must not be, or nothing is written.
 * Throws with the reason; after a failure past the first write, with how to recover.
 */
export function commitSentry(dir: string, files: readonly SentryFile[], opts: { branch?: string; onto?: string } = {}): void {
  const root = resolve(dir)
  const onto = opts.onto
    ? `the banner (and any fonts) are committed on ${opts.onto}, the Sentry bundle is not: git reset --hard && git clean -fd drops it and keeps those commits; to start over: git reset --hard && git clean -fd && git switch main && git branch -D ${opts.onto}`
    : null
  const fail = (message: string): never => {
    throw new Error(onto ? `${message}\n${onto}` : message)
  }
  if (existsSync(join(root, SENTRY_FILE))) fail(`${SENTRY_FILE} already exists, nothing written`)
  for (const f of files) {
    if (f.before !== null && readFileSync(join(root, f.path), 'utf8') !== f.before) fail(`${f.path} changed since it was planned, nothing written: run detect and the command again`)
  }
  if (opts.branch) startBranch(root, opts.branch)
  try {
    writeFiles(root, files.map((f) => ({ path: f.path, data: f.after })))
    commitAllowed(root, new Set(files.map((f) => f.path)), SENTRY_COMMIT_MESSAGE)
  } catch (e) {
    const how = onto ?? recovery(opts.branch ?? execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim())
    throw new Error(`${(e as Error).message}\n${how}`)
  }
}
