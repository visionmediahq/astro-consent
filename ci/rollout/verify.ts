// The verify stage (spec C3): eight checks on a wired site's consent-banner branch, run in order,
// stopping at the first failure. Each step writes .rollout/evidence/<n>-<name>.txt, and the whole
// result goes to .rollout/verify.json.
//
//   1 lockfile    npm ci in both; package-lock diff against main within the allowlist, and
//                 `npm ls astro vite @tailwindcss/vite` the same on both sides
//   2 build       npm run build on the branch
//   3 requests    main and branch previews over every built page: main RED (or noted green), the
//                 branch shows the banner, requests nothing from the registry before consent and
//                 logs no console error main didn't; a registry request on a page detect didn't
//                 know is a detect miss
//   4 consent-paths  Visa / Visa alltid / Neka on every page with an embed
//   5 clip        no banner or embed button clipped, no banner button covered, no page wider than
//                 on main, at 320/360/375/1280 px
//   6 contrast    every banner button and PrivacyLinks row ≥ 4.5:1 and determinate (Ruling 20)
//   7 screenshots banner and map placeholders at 360 and 1280 px
//   8 docker      the pushed branch cloned clean, built with its Dockerfile, steps 3–4 against it
//
// `main` is built in a git worktree beside the clone (`<clone>-main`), so its node_modules and dist
// never sit inside the site where Tailwind's source scan or tsc could see them.
//
// Demo mode (`demo: true`, CI/self-test): `dir` is a built demo dist (demo/dist-consent); no git,
// no npm, no Docker, no network. Steps 1, 2 and 8 are skipped and step 3 has no main side.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser } from '@playwright/test'
import { type ClipResult, checkClip } from './checks/clip'
import { type ConsentPathResult, checkConsentPaths } from './checks/consent-paths'
import { type ContrastRow, checkContrast } from './checks/contrast'
import { isCmsAdminRoute, listPages, MISSING_PREFIX } from './checks/pages'
import { checkRequests, formatRequests, type RequestResult } from './checks/requests'
import { shots } from './checks/shots'
import { isRoute, routeOf } from './detect/structure'
import { dockerCheck } from './docker'
import { type Exec, exec as realExec, tail } from './lib/exec'
import { diffLock, diffPackageJson } from './lib/lockfile'
import { type Preview, startPreview } from './preview'
import type { Report, StepResult, VerifyResult } from './types'
import { BRANCH } from './wire/index'

export type { Exec } from './lib/exec'

export const PKG = '@visionmediahq/astro-consent'
export const PORTS = { branch: 4399, main: 4398 } as const
const DOCUMENT_404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
const NPM_LS = ['ls', 'astro', 'vite', '@tailwindcss/vite', '--all', '--json']

/** The browser side of verify, behind one interface so tests can answer it. */
export interface Checks {
  /** Every page to check, ending with one missing URL for the 404 page. */
  pages(base: string, opts: { distDir: string; ssr: boolean }): Promise<string[]>
  /** The paths among `paths` whose HTML holds a ConsentEmbed. */
  embedPages(base: string, paths: string[]): Promise<string[]>
  requests(base: string, paths: string[], opts: { baseline?: Set<string>; expectBanner?: (path: string) => boolean }): Promise<RequestResult[]>
  consentPaths(base: string, mapPaths: string[], opts: { expectFilter?: (path: string) => boolean }): Promise<ConsentPathResult[]>
  clip(base: string, paths: string[]): Promise<ClipResult[]>
  contrast(base: string, paths: string[]): Promise<ContrastRow[]>
  shots(base: string, paths: string[], outDir: string): Promise<string[]>
  close(): Promise<void>
}

export interface VerifyDeps {
  exec: Exec
  preview: (dir: string, port: number, ssr: boolean, entry?: string) => Promise<Preview>
  checks: () => Promise<Checks>
  /** `buildArgs`: what Coolify passes as build variables (SITE_URL from the site's first domain). */
  docker: (repoUrl: string, branch: string, run: (url: string) => Promise<boolean>, buildArgs?: Record<string, string>) => Promise<{ pass: boolean; log: string }>
}

export interface VerifyOptions {
  deps?: Partial<VerifyDeps>
  /** CI/self-test mode: `dir` is a built demo dist dir. */
  demo?: boolean
  /** Where evidence and verify.json go; default `<dir>/.rollout`. */
  out?: string
}

/** Step 8 clones only Vision Media's own GitHub repos (Ruling 34b). */
export const ORIGIN = /^(git@github\.com:|https:\/\/github\.com\/)visionmediahq\//

/** The remote head of consent-banner verify last pushed, so a rerun may replace its own push. */
export const PUSHED_FILE = 'pushed.txt'

const norm = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/** Fetches each path's HTML and keeps those with a ConsentEmbed (`data-consent-embed`). */
export async function embedPagesByFetch(base: string, paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of paths) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(15_000) })
      if ((await res.text()).includes('data-consent-embed')) out.push(path)
    } catch {
      // unreachable page: step 3 reports it
    }
  }
  return out
}

/**
 * The real checks: one Chromium, launched on first use, every registry and log-host request stubbed
 * (local and Docker runs never reach Google or a log endpoint). For `output: 'server'` the pages are
 * the crawl plus the prerendered `client/**\/*.html`.
 */
export function browserChecks(): Checks {
  let browser: Promise<Browser> | null = null
  const get = (): Promise<Browser> => (browser ??= import('@playwright/test').then((p) => p.chromium.launch()))
  return {
    async pages(base, { distDir, ssr }) {
      if (!ssr) return listPages(base, { distDir, ssr: false })
      const crawled = await listPages(base, { ssr: true })
      const missing = crawled.pop()!
      const client = join(distDir, 'client')
      const built = existsSync(client) ? (await listPages(base, { distDir: client, ssr: false })).filter((p) => !p.startsWith(MISSING_PREFIX)) : []
      const seen = new Map<string, string>()
      for (const p of [...crawled, ...built]) if (!seen.has(norm(p))) seen.set(norm(p), p)
      return [...seen.values(), missing]
    },
    embedPages: embedPagesByFetch,
    requests: async (base, paths, opts) => checkRequests(await get(), base, paths, { ...opts, stub: true }),
    consentPaths: async (base, paths, opts) => checkConsentPaths(await get(), base, paths, { ...opts, stub: true }),
    clip: async (base, paths) => checkClip(await get(), base, paths, [320, 360, 375, 1280], { stub: true }),
    contrast: async (base, paths) => checkContrast(await get(), base, paths, { stub: true }),
    shots: async (base, paths, outDir) => shots(await get(), base, paths, outDir, [360, 1280], { stub: true }),
    async close() {
      if (browser) await (await browser).close()
    },
  }
}

const realDeps = (): VerifyDeps => ({
  exec: realExec,
  preview: startPreview,
  checks: async () => browserChecks(),
  docker: (url, branch, run, buildArgs) => dockerCheck(url, branch, run, {}, buildArgs),
})

/** Page files that render `file`: itself if it is a route, else the pages of a layout it is. */
function pagesOf(report: Report, file: string): string[] {
  if (file.startsWith('src/pages/')) return [file]
  return report.layouts.find((l) => l.file === file)?.pages ?? []
}

/** Routes of iframes detect found that sit on a page, a layout or a component call site. */
function iframeRoutes(report: Report, keep: (i: Report['iframes'][number]) => boolean): Set<string> {
  const routes = new Set<string>()
  for (const iframe of report.iframes.filter(keep)) {
    const files = [iframe.file, ...(iframe.callSites ?? []).map((c) => c.file)].flatMap((f) => pagesOf(report, f))
    for (const file of files) if (isRoute(file) && !file.includes('[')) routes.add(norm(routeOf(file)))
  }
  return routes
}

/** The routes of the pages detect knows have a map (dynamic routes left out). */
export const mapRoutes = (report: Report): Set<string> => iframeRoutes(report, () => true)

const FILTER_CLASS = /(?:^|\s)!?(?:grayscale|sepia|invert|blur|brightness-|contrast-|hue-rotate-|saturate-|drop-shadow)/

/** Routes whose map had a CSS filter detect could see (inline style or a Tailwind filter class). */
const filterRoutes = (report: Report): Set<string> =>
  iframeRoutes(report, (i) => /(?:^|;)\s*filter\s*:/.test(i.style ?? '') || FILTER_CLASS.test(i.classes ?? ''))

/** `name@version` for astro, vite and @tailwindcss/vite anywhere in `npm ls --json` output. */
export function lsVersions(json: string): string[] {
  const names = new Set(['astro', 'vite', '@tailwindcss/vite'])
  const out = new Set<string>()
  type Node = { version?: string; dependencies?: Record<string, Node> }
  const walk = (deps: Record<string, Node> | undefined) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (names.has(name)) out.add(`${name}@${node.version ?? '(missing)'}`)
      walk(node.dependencies)
    }
  }
  walk((JSON.parse(json) as Node).dependencies)
  return [...out].sort()
}

interface Outcome {
  pass: boolean
  lines: string[]
  skipped?: boolean
}

const STEPS = ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'docker'] as const

/**
 * Runs C3 on the checkout `dir` (on branch consent-banner) for `report`. Pushes the branch first
 * (step 8 clones from GitHub), then runs steps 1–8 and stops at the first failure. Throws only when
 * `dir` is not on consent-banner.
 */
export async function verify(dir: string, report: Report, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const deps: VerifyDeps = { ...realDeps(), ...opts.deps }
  const { exec } = deps
  const root = resolve(dir)
  const demo = opts.demo === true
  const out = opts.out ?? join(root, '.rollout')
  const evidenceDir = join(out, 'evidence')
  // Evidence and screenshots from an earlier run must not pass for this one's.
  rmSync(evidenceDir, { recursive: true, force: true })
  rmSync(join(out, 'shots'), { recursive: true, force: true })
  mkdirSync(evidenceDir, { recursive: true })

  const steps: StepResult[] = []
  const record = (step: number, name: string, o: Outcome): boolean => {
    const evidence = o.lines.join('\n')
    writeFileSync(join(evidenceDir, `${step}-${name}.txt`), `${evidence}\n`)
    steps.push({ step, name, pass: o.pass, evidence, ...(o.skipped ? { skipped: true } : {}) })
    return o.pass
  }
  const finish = (): VerifyResult => {
    const result: VerifyResult = { pass: steps.length > 0 && steps.every((s) => s.pass), sha, steps }
    writeFileSync(join(out, 'verify.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  const git = (...args: string[]) => exec('git', args, root)
  let sha: string | null = null

  const mainDir = demo ? null : `${root.replace(/\/+$/, '')}-main`
  /** Whether `mainDir` is listed by `git worktree list` as one of this clone's worktrees. */
  let staleWorktree = false
  if (!demo) {
    const head = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out.trim()
    if (head !== BRANCH) throw new Error(`verify runs on branch ${BRANCH}; ${root} is on ${head || '(unknown)'}`)
    if (existsSync(mainDir!)) {
      const real = (p: string): string => {
        try {
          return realpathSync(p)
        } catch {
          return resolve(p)
        }
      }
      const listed = (await git('worktree', 'list', '--porcelain')).out
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => real(l.slice('worktree '.length)))
      if (!listed.includes(real(mainDir!))) {
        throw new Error(`${mainDir} exists but is not a worktree of this clone: move it away, verify will not delete it`)
      }
      staleWorktree = true
    }
    // The checks run on the working tree, but the result is recorded for HEAD: both must be one.
    const status = await git('status', '--porcelain', '--untracked-files=all')
    if (status.code !== 0 || status.out.trim() !== '') {
      const what = status.code !== 0 ? ['git status failed:', tail(status.out)] : ['uncommitted or untracked files:', status.out.trimEnd()]
      record(0, 'clean', { pass: false, lines: ['the working tree is not clean: commit your changes, then rerun verify', ...what] })
      return finish()
    }
    // Never force-push over a consent-banner on GitHub that this tool did not push (a fresh clone
    // sees someone else's branch as origin/consent-banner, so --force-with-lease alone would not stop it).
    const local = (await git('rev-parse', 'HEAD')).out.trim()
    const remote = await git('ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`)
    const remoteSha = headSha(remote.out)
    const pushedPath = join(out, PUSHED_FILE)
    const pushed = existsSync(pushedPath) ? readFileSync(pushedPath, 'utf8').trim() : ''
    if (remote.code !== 0) {
      record(0, 'push', { pass: false, lines: [`git ls-remote --heads origin refs/heads/${BRANCH} failed: cannot tell whether the branch on GitHub is ours`, tail(remote.out)] })
      return finish()
    }
    if (remoteSha !== '' && remoteSha !== local && remoteSha !== pushed) {
      record(0, 'push', {
        pass: false,
        lines: [
          `origin/${BRANCH} is ${remoteSha}, which this tool did not push (last push: ${pushed || 'none'}); HEAD is ${local || '(unknown)'}.`,
          'Not force-pushing over it: find out whose branch it is, and delete or rename it on GitHub by hand.',
        ],
      })
      return finish()
    }
    const push = await git('push', '--force-with-lease', 'origin', BRANCH)
    if (push.code !== 0) {
      record(0, 'push', { pass: false, lines: [`git push --force-with-lease origin ${BRANCH} failed:`, tail(push.out)] })
      return finish()
    }
    sha = (await git('rev-parse', 'HEAD')).out.trim() || null
    if (sha) writeFileSync(pushedPath, `${sha}\n`)
  }

  const ssr = demo || report.astro.output === 'server'
  const known = mapRoutes(report)
  const filters = filterRoutes(report)
  const expectFilter = filters.size ? (p: string) => filters.has(norm(p)) : undefined
  // CMS admin shells (src/pages/admin/, or Decap's public/admin/ copied to dist/admin/) never get the banner.
  const expectBanner = demo ? (p: string) => norm(p) !== '/utan-banner' && !p.startsWith(MISSING_PREFIX) : (p: string) => !isCmsAdminRoute(p)
  const previews: Preview[] = []
  let checks = null as Checks | null
  const getChecks = async () => (checks ??= await deps.checks())
  let branch = null as Preview | null
  let paths: string[] = []
  let mapPages: string[] = []
  // Demo mode has no main side to record a baseline: the one error main always has is the missing
  // URL's own 404 document, which Chromium logs without its URL.
  let baseline = new Set<string>(demo ? [DOCUMENT_404] : [])

  /** The baseline (held with the branch preview's host) with `base`'s host instead, for the container. */
  const rebase = (base: string): Set<string> => new Set([...baseline].map((e) => e.replaceAll(new URL(branch!.url).host, new URL(base).host)))

  const consentPathLines = (results: ConsentPathResult[]): { pass: boolean; lines: string[] } => {
    const lines: string[] = []
    let pass = results.length === mapPages.length
    if (!pass) lines.push(`${results.length} results for ${mapPages.length} pages with an embed`)
    for (const r of results) {
      const ok = r.visaLoadsOnlyClicked && r.rememberAutoShows && r.nekaLoadsNothing && r.filterKept !== false
      pass &&= ok
      lines.push(
        `${r.path}: visa=${r.visaLoadsOnlyClicked} visa-alltid=${r.rememberAutoShows} neka=${r.nekaLoadsNothing} ` +
          `filter=${r.filterKept === null ? 'not asserted' : r.filterKept} (${r.filter}) open=${r.openHref ?? '-'} ${ok ? 'ok' : 'FAIL'}`,
        ...r.notes.map((n) => `  ${n}`),
      )
    }
    return { pass, lines }
  }

  const run: Record<(typeof STEPS)[number], () => Promise<Outcome>> = {
    async lockfile() {
      if (demo) return { pass: true, skipped: true, lines: ['skipped (demo)'] }
      const lines: string[] = []
      for (const [side, cwd] of [['main', mainDir!], ['branch', root]] as const) {
        const ci = await exec('npm', ['ci', '--no-audit', '--no-fund'], cwd)
        if (ci.code !== 0) return { pass: false, lines: [`npm ci failed on ${side}:`, tail(ci.out)] }
      }
      const branchPkg = readFileSync(join(root, 'package.json'), 'utf8')
      let engines: unknown
      try {
        engines = (JSON.parse(branchPkg) as { engines?: unknown }).engines
      } catch {
        engines = undefined // the package.json comparison below reports it
      }
      const { allowed, unknown } = diffLock(readFileSync(join(mainDir!, 'package-lock.json'), 'utf8'), readFileSync(join(root, 'package-lock.json'), 'utf8'), PKG, { engines })
      lines.push('package-lock.json, main → branch:', ...allowed.map((l) => `  allowed ${l}`), ...unknown.map((l) => `  UNKNOWN ${l}`))
      const mainPkg = await git('show', 'origin/main:package.json')
      let pkgChanges: string[]
      try {
        pkgChanges = diffPackageJson(mainPkg.out, branchPkg, PKG)
      } catch (e) {
        pkgChanges = [`could not compare package.json with origin/main: ${(e as Error).message}`]
      }
      lines.push(`package.json, main → branch: ${pkgChanges.length ? 'CHANGED beyond the package' : `only ${PKG} added`}`, ...pkgChanges.map((l) => `  UNKNOWN ${l}`))
      const ls: Record<string, string[]> = {}
      for (const [side, cwd] of [['main', mainDir!], ['branch', root]] as const) {
        const res = await exec('npm', NPM_LS, cwd)
        try {
          ls[side] = lsVersions(res.out)
        } catch {
          return { pass: false, lines: [...lines, `npm ls on ${side} gave no JSON (exit ${res.code}):`, tail(res.out)] }
        }
      }
      const same = JSON.stringify(ls['main']) === JSON.stringify(ls['branch'])
      lines.push(`npm ls astro vite @tailwindcss/vite: ${same ? 'same' : 'DIFFERENT'}`, `  main   ${ls['main']!.join(' ')}`, `  branch ${ls['branch']!.join(' ')}`)
      return { pass: unknown.length === 0 && pkgChanges.length === 0 && same, lines }
    },

    async build() {
      if (demo) return { pass: true, skipped: true, lines: ['skipped (demo)'] }
      const res = await exec('npm', ['run', 'build'], root)
      return { pass: res.code === 0, lines: ['npm ci: done in step 1', `npm run build exit ${res.code}`, tail(res.out)] }
    },

    async requests() {
      const lines: string[] = []
      let mainResults: RequestResult[] = []
      if (!demo) {
        const res = await exec('npm', ['run', 'build'], mainDir!)
        if (res.code !== 0) return { pass: false, lines: ['npm run build failed on main:', tail(res.out)] }
      }
      branch = await deps.preview(root, PORTS.branch, ssr, demo ? 'server/entry.mjs' : undefined)
      previews.push(branch)
      const c = await getChecks()
      paths = await c.pages(branch.url, { distDir: demo ? root : join(root, 'dist'), ssr })
      lines.push(`pages (${paths.length}): ${paths.join(' ')}`)
      if (!paths.some((p) => norm(p) === '/')) return { pass: false, lines: [...lines, '"/" is not among the pages: the page list is broken'] }
      if (!demo) {
        const main = await deps.preview(mainDir!, PORTS.main, ssr)
        previews.push(main)
        mainResults = await c.requests(main.url, paths, {})
        const mainHost = new URL(main.url).host
        baseline = new Set(mainResults.flatMap((r) => r.errors).map((e) => e.replaceAll(mainHost, new URL(branch!.url).host)))
        lines.push('main (expected RED: no banner, registry requested on map pages):', ...formatRequests(mainResults).map((l) => `  ${l}`))
        const green = [
          ...(mainResults.some((r) => r.banner) ? ['shows a banner'] : []),
          ...(mainResults.every((r) => r.blocked.length === 0) ? ['requests nothing from the registry'] : []),
        ]
        if (green.length) lines.push(`main already green: ${green.join(', ')} (noted, not a failure)`)
        await main.stop()
      }
      const results = await c.requests(branch.url, paths, { baseline, expectBanner })
      lines.push('branch:', ...formatRequests(results).map((l) => `  ${l}`))
      // Step 4 clicks the banner, so a page meant to have none (demo: /utan-banner) is left out.
      mapPages = (await c.embedPages(branch.url, paths)).filter(expectBanner)
      const knownPages = new Set([...known, ...mapPages.map(norm)])
      const misses = [...new Set([...mainResults, ...results].filter((r) => r.blocked.length > 0 && !knownPages.has(norm(r.path))).map((r) => r.path))]
      lines.push(`pages with an embed: ${mapPages.join(' ') || '(none)'}`, ...misses.map((p) => `detect miss: ${p}`))
      return { pass: results.length > 0 && results.every((r) => r.ok) && misses.length === 0, lines }
    },

    async 'consent-paths'() {
      const lines = [`pages with an embed: ${mapPages.join(' ') || '(none)'}`]
      const withEmbed = new Set(mapPages.map(norm))
      const lost = [...known].filter((r) => !withEmbed.has(r))
      lines.push(...lost.map((r) => `detect found a map on ${r}, but the built page has no embed`))
      if (mapPages.length === 0) {
        const pass = report.classification !== 'maps' && lost.length === 0
        return { pass, lines: [...lines, pass ? 'no map pages: nothing to check' : 'a maps site with no embed on any built page'] }
      }
      const r = consentPathLines(await (await getChecks()).consentPaths(branch!.url, mapPages, { expectFilter }))
      return { pass: r.pass && lost.length === 0, lines: [...lines, ...r.lines] }
    },

    async clip() {
      const c = await getChecks()
      const rows = await c.clip(branch!.url, [...new Set(['/', ...mapPages])])
      // A page that already scrolls sideways on main (a site's own wide hamburger) is not the
      // banner's doing: main is measured for those paths, and only a wider branch fails.
      const mainW = new Map<string, number>()
      const wide = rows.filter((r) => r.kind === 'page' && r.clipped)
      if (!demo && wide.length) {
        const main = await deps.preview(mainDir!, PORTS.main, ssr)
        previews.push(main)
        try {
          for (const m of await c.clip(main.url, [...new Set(wide.map((r) => r.path))]))
            if (m.kind === 'page') mainW.set(`${m.path} ${m.width}`, m.w)
        } finally {
          await main.stop()
        }
      }
      const lines: string[] = []
      for (const r of rows) {
        const onMain = r.kind === 'page' && r.clipped ? mainW.get(`${r.path} ${r.width}`) : undefined
        if (onMain !== undefined && onMain >= r.w) r.clipped = false
        const why = `${r.over ? ' (text overflows)' : ''}${r.out ? ' (sticks out)' : ''}${r.covered ? ' (covered by another element)' : ''}`
        const main = onMain === undefined ? '' : r.clipped ? ` (main ${onMain}px)` : ` (main ${onMain}px too: not the banner)`
        lines.push(`${r.path} ${r.width}px ${r.kind} "${r.button}" ${r.w}px in ${r.boxW}px ${r.clipped ? `CLIPPED${why}` : 'ok'}${main}`)
      }
      const measured = rows.some((r) => r.kind === 'button')
      if (!measured) lines.push('no banner or embed button was measured')
      return { pass: measured && rows.every((r) => !r.clipped), lines }
    },

    async contrast() {
      const rows = await (await getChecks()).contrast(branch!.url, paths)
      const lines = rows.map(
        (r) =>
          `${r.path ?? ''} ${r.kind} "${r.button}" ${r.ratio.toFixed(2)}:1 ${r.ok ? 'ok' : 'FAIL'}${r.indeterminate ? ` (indeterminate: ${r.indeterminate})` : ''}`,
      )
      // Ruling 20: every page that should show the banner has banner and PrivacyLinks rows. CMS admin
      // pages (Ruling 26) get neither and are left out by expectBanner.
      const missing: string[] = []
      for (const p of paths.filter(expectBanner)) {
        const own = rows.filter((r) => norm(r.path ?? '') === norm(p))
        if (!own.some((r) => r.kind === 'banner')) missing.push(`${p}: no banner button measured`)
        if (!isCmsAdminRoute(p) && !own.some((r) => r.kind === 'links')) missing.push(`${p}: no PrivacyLinks text measured`)
      }
      lines.push(...missing)
      return { pass: missing.length === 0 && rows.every((r) => r.ok), lines }
    },

    async screenshots() {
      const missing = paths.find((p) => p.startsWith(MISSING_PREFIX))
      const files = await (await getChecks()).shots(branch!.url, [...new Set(['/', ...mapPages, ...(missing ? [missing] : [])])], join(out, 'shots'))
      return { pass: files.length > 0, lines: [`${files.length} files in ${join(out, 'shots')}`, ...files] }
    },

    async docker() {
      if (demo) return { pass: true, skipped: true, lines: ['skipped (demo)'] }
      const local = (await git('rev-parse', 'HEAD')).out.trim()
      const remote = headSha((await git('ls-remote', 'origin', `refs/heads/${BRANCH}`)).out)
      if (!local || remote !== local) return { pass: false, lines: [`origin/${BRANCH} is ${remote || '(missing)'}, HEAD is ${local}: push the branch first`] }
      const repoUrl = (await git('remote', 'get-url', 'origin')).out.trim()
      if (!ORIGIN.test(repoUrl)) return { pass: false, lines: [`origin is ${repoUrl || '(none)'}, not a github.com/visionmediahq repo: step 8 clones only from there`] }
      const lines = [`origin/${BRANCH} = HEAD = ${local}`]
      const c = await getChecks()
      const result = await deps.docker(repoUrl, BRANCH, async (url) => {
        const results = await c.requests(url, paths, { baseline: rebase(url), expectBanner })
        lines.push('step 3 against the container:', ...formatRequests(results).map((l) => `  ${l}`))
        let pass = results.length > 0 && results.every((r) => r.ok)
        if (mapPages.length) {
          const r = consentPathLines(await c.consentPaths(url, mapPages, { expectFilter }))
          lines.push('step 4 against the container:', ...r.lines.map((l) => `  ${l}`))
          pass &&= r.pass
        }
        return pass
      }, report.domains[0] ? { SITE_URL: `https://${report.domains[0]}` } : {})
      return { pass: result.pass, lines: [...lines, result.log] }
    },
  }

  try {
    if (mainDir) {
      if (staleWorktree) {
        await git('worktree', 'remove', '--force', mainDir)
        rmSync(mainDir, { recursive: true, force: true })
        await git('worktree', 'prune')
      }
      const fetched = await git('fetch', 'origin', 'main')
      const added = fetched.code === 0 ? await git('worktree', 'add', '--detach', mainDir, 'origin/main') : fetched
      if (added.code !== 0) {
        record(1, 'lockfile', { pass: false, lines: ['could not check out origin/main beside the clone:', tail(added.out)] })
        return finish()
      }
    }
    for (const [i, name] of STEPS.entries()) {
      let outcome: Outcome
      try {
        outcome = await run[name]()
      } catch (e) {
        outcome = { pass: false, lines: [`${name} threw: ${(e as Error).stack ?? String(e)}`] }
      }
      if (!record(i + 1, name, outcome)) break
    }
    // npm ci and the build ran in the clone: whatever they left uncommitted makes the next verify
    // refuse at its own clean check, so it is reported now, as the site's problem it is.
    if (!demo) {
      const after = await git('status', '--porcelain', '--untracked-files=all')
      if (after.code !== 0 || after.out.trim() !== '') {
        const what = after.code !== 0 ? ['git status failed:', tail(after.out)] : ['left by npm ci or the build:', after.out.trimEnd()]
        record(STEPS.length + 1, 'clean', {
          pass: false,
          lines: ["verify's own npm ci or build left the working tree dirty, so the next verify would refuse: add these to the site's .gitignore on the branch, commit, then rerun verify", ...what],
        })
      }
    }
    return finish()
  } finally {
    for (const p of previews) await p.stop().catch(() => undefined)
    if (checks) await checks.close().catch(() => undefined)
    if (mainDir) await git('worktree', 'remove', '--force', mainDir)
  }
}

/** The sha of exactly refs/heads/consent-banner in `git ls-remote` output ('' when absent). */
function headSha(out: string): string {
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/heads/${BRANCH}`) return sha ?? ''
  }
  return ''
}

/** One line per step, as run.ts prints them. */
export function formatVerify(result: VerifyResult): string[] {
  return [
    ...result.steps.map((s) => `step ${s.step} ${s.name}: ${s.skipped ? 'skipped' : s.pass ? 'pass' : 'FAIL'}`),
    `verify: ${result.pass ? 'PASS' : 'FAIL'}`,
  ]
}
