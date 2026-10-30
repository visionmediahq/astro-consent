// The verify stage (spec C3): the checks of a wired site's branch, run in order, stopping at the
// first failure. The branch picks the flow (flows.ts): consent-banner runs every step but 8 (fonts
// only when the branch self-hosts them), fonts-selfhost skips the banner-only 4 and 6. Each step
// writes .rollout/evidence/<n>-<name>.txt, and the whole result goes to .rollout/verify.json (on
// fonts-selfhost with the branch in each name: evidence-fonts-selfhost/, verify-fonts-selfhost.json).
//
//   1 lockfile    npm ci in both; package-lock diff against main within the allowlist, and
//                 `npm ls astro vite @tailwindcss/vite` the same on both sides. fonts-selfhost and
//                 sentry-selfhost: package.json and package-lock.json exactly main's, and only the
//                 fonts' (or the Sentry bundle's) files changed
//   2 build       npm run build on the branch; on consent-banner, every daisyUI part the banner
//                 uses has a rule in the built CSS (#101; demo mode runs only this); with the tool's
//                 Sentry bundle committed, it hashes to the recorded SRI and no source still loads
//                 Sentry from a CDN (checks/sentry.ts; without it, a CDN load is noted, and on
//                 sentry-selfhost it is a failure) (#93)
//   3 requests    main and branch previews over every built page: main RED (or noted green), the
//                 branch shows the banner, requests nothing from the registry (or Sentry's CDNs,
//                 #93) before consent and logs no console error main didn't; a registry request on
//                 a page detect didn't know is a detect miss
//   4 consent-paths  Visa / Visa alltid / Neka on every page with an embed
//   5 clip        no banner or embed button clipped or cut off by an overflow:hidden ancestor, no
//                 banner button covered, no page wider than
//                 on main, at 320/360/375/1280 px; no embed placeholder more than 10 % shorter than
//                 the iframe of its service it replaced on main, at 360/1280 px (#46)
//   6 contrast    every banner button, PrivacyLinks row and embed placeholder text ≥ 4.5:1 and
//                 determinate (Ruling 20, #46)
//   7 screenshots banner and map placeholders at 360 and 1280 px
//   8 fonts       self-hosted Google Fonts (checks/fonts.ts): no Google host in dist/, no request to
//                 Google and every /fonts/*.woff2 200 at 360/1280 px, every face used loaded, every
//                 character shown in a self-hosted family within its kept unicode-ranges
//   9 docker      the pushed branch cloned clean, built with its Dockerfile, steps 3–4 (and 8's
//                 requests) against it
//
// `main` is built in a git worktree beside the clone (`<clone>-main`), so its node_modules and dist
// never sit inside the site where Tailwind's source scan or tsc could see them.
//
// Demo mode (`demo: true`, CI/self-test): `dir` is a built demo dist (demo/dist-consent); no git,
// no npm, no Docker, no network. Steps 1, 2 and 9 are skipped and step 3 has no main side.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Browser } from '@playwright/test'
import { type ClipResult, checkClip } from './checks/clip'
import { type RootStyles, checkRootStyles, diffRootStyles } from './checks/root-styles'
import { type ConsentPathResult, checkConsentPaths } from './checks/consent-paths'
import { type ContrastRow, checkContrast, formatContrast } from './checks/contrast'
import { checkEmbedBoxes, compareEmbedHeights, type EmbedBox } from './checks/embed-size'
import {
  checkCoverage,
  checkFonts,
  coverageLines,
  css2UrlOf,
  distMentions,
  type FontsPage,
  judgeFontsPage,
  pageTexts,
  parseFontsCss,
  shippedNotes,
  shippedStrings,
  shippedTexts,
} from './checks/fonts'
import { fontsCheckPaths, isCmsAdminRoute, listPages, MISSING_PREFIX } from './checks/pages'
import { checkRequests, formatRequests, isSentryEntry, type RequestResult } from './checks/requests'
import { checkSentrySource } from './checks/sentry'
import { shots } from './checks/shots'
import { isRoute, routeOf } from './detect/structure'
import { dockerCheck } from './docker'
import { type Exec, type ExecResult, exec as realExec, tail } from './lib/exec'
import { builtCss, neededParts, type Part, partsMissingFromBuild } from './lib/daisyui'
import { diffLock, diffPackageJson } from './lib/lockfile'
import { lockPorts, type Ports, PortsBusy, rolloutPorts } from './lib/ports'
import { SENTRY_FILE } from './lib/sentry'
import { diskSite } from './lib/site-files'
import { toolLine, type ToolVersion, toolVersion } from './lib/tool-version'
import { isUp, type Preview, previewLog, ssrEntry, startPreview } from './preview'
import { type Flow, FLOWS, flowOf, FONTS_MARKER, isToolFontsCss, statePath, STEPS, type StepName } from './flows'
import type { Report, StepResult, VerifyResult } from './types'
import type { ServiceSlug } from '../../src/services'
import { CHROME_UA, FONTS_CSS, FONTS_DIR, type FontFetch, httpFetch } from './wire/fonts'
import { SENTRY_BRANCH } from './wire/sentry'
import { compareVersions, installedOf, UPDATE_BRANCH } from './wire/update'
import { type Face, parseCss2 } from './wire/fonts-css'

export type { Exec } from './lib/exec'

export const PKG = '@visionmediahq/astro-consent'
const DOCUMENT_404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
const NPM_LS = ['ls', 'astro', 'vite', '@tailwindcss/vite', '--all', '--json']

/** The browser side of verify, behind one interface so tests can answer it. */
export interface Checks {
  /** Every page to check, ending with one missing URL for the 404 page. */
  pages(base: string, opts: { distDir: string; ssr: boolean }): Promise<string[]>
  /** The paths among `paths` whose HTML holds a ConsentEmbed. */
  embedPages(base: string, paths: string[]): Promise<string[]>
  requests(base: string, paths: string[], opts: { baseline?: Set<string>; expectBanner?: (path: string) => boolean }): Promise<RequestResult[]>
  consentPaths(base: string, mapPaths: string[], opts: { expectFilter?: (path: string) => ServiceSlug | null }): Promise<ConsentPathResult[]>
  clip(base: string, paths: string[]): Promise<ClipResult[]>
  /** Computed scrollbar and background styles on html and body of `/`, compared with main in step 5. */
  rootStyles(base: string): Promise<RootStyles>
  /** Main's registry iframes or the branch's unloaded ConsentEmbeds at 360 and 1280px, compared in step 5 (#46). */
  embedBoxes(base: string, paths: string[]): Promise<EmbedBox[]>
  contrast(base: string, paths: string[]): Promise<ContrastRow[]>
  shots(base: string, paths: string[], outDir: string): Promise<string[]>
  /** Step 8: every path at `widths` (default 360 and 1280), Google Fonts blocked and counted. */
  fonts(base: string, paths: string[], opts?: { widths?: number[] }): Promise<FontsPage[]>
  /** Step 2: the daisyUI parts the banner uses that have no rule in the CSS built into `distDir` (#101). */
  daisyuiParts(distDir: string): Part[]
  close(): Promise<void>
}

export interface VerifyDeps {
  exec: Exec
  preview: (dir: string, port: number, ssr: boolean, entry?: string) => Promise<Preview>
  checks: () => Promise<Checks>
  /** `buildArgs`: what Coolify passes as build variables (SITE_URL from the site's first domain). */
  docker: (repoUrl: string, branch: string, run: (url: string) => Promise<boolean>, buildArgs?: Record<string, string>) => Promise<{ pass: boolean; log: string }>
  /** Bytes free to an unprivileged user on the file system holding `dir`. */
  freeBytes: (dir: string) => number
  /** Whether anything still answers at `url` (main's preview, after a connection error). */
  isUp: (url: string) => Promise<boolean>
  /** Step 8 asks Google's css2 URL (from fonts.css) which characters its faces offer; tests answer it. */
  fontFetch: FontFetch
  /** The tool's own commit, recorded in the result (lib/tool-version.ts). */
  toolVersion: () => ToolVersion
  /** Where the per-base port lock lives (#87): the OS temp dir, so every verify on the machine sees it. */
  lockDir: string
}

export interface VerifyOptions {
  deps?: Partial<VerifyDeps>
  /** Free disk verify needs before it starts, GB (#23). Default ROLLOUT_MIN_FREE_GB, else 15. */
  minFreeGb?: number
  /** CI/self-test mode: `dir` is a built demo dist dir. */
  demo?: boolean
  /** Where evidence and the verify file (per branch, flows.ts) go; default `<dir>/.rollout`. */
  out?: string
}

/** Step 9 clones only Vision Media's own GitHub repos (Ruling 34b). */
export const ORIGIN = /^(git@github\.com:|https:\/\/github\.com\/)visionmediahq\//

/** The remote head of the branch verify last pushed, so a rerun may replace its own push (per branch, flows.ts). */
export const PUSHED_FILE = 'pushed.txt'
/** The result (fonts-selfhost: verify-fonts-selfhost.json, flows.ts stateName). */
export const VERIFY_FILE = 'verify.json'

const norm = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/**
 * Whether the page renders a ConsentEmbed or ConsentWidget: an element carrying `data-consent-embed`.
 * The name alone is not enough: a site with `build.inlineStylesheets: 'always'` inlines the banner's
 * CSS, whose selectors name the attribute, into every page; an inlined script can name it too.
 * Comments go in the same left-to-right pass, so a commented-out `<script>` cannot swallow the page,
 * and the tag body is read quote-aware, so a `>` in an earlier attribute value does not end it.
 * The attribute may follow a closing quote with no space, as an HTML minifier writes it.
 */
export function hasConsentEmbed(html: string): boolean {
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)(?=[\s/>])[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  return /<[a-z](?:[^>"']|"[^"]*"|'[^']*')*(?<=[\s"'])data-consent-embed(?=[\s=>/])/i.test(markup)
}

/** Fetches each path's HTML and keeps those with a ConsentEmbed (`data-consent-embed`). */
export async function embedPagesByFetch(base: string, paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of paths) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(15_000) })
      if (hasConsentEmbed(await res.text())) out.push(path)
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
    rootStyles: async (base) => checkRootStyles(await get(), base, '/', { stub: true }),
    embedBoxes: async (base, paths) => checkEmbedBoxes(await get(), base, paths, [360, 1280], { stub: true }),
    contrast: async (base, paths) => checkContrast(await get(), base, paths, { stub: true }),
    shots: async (base, paths, outDir) => shots(await get(), base, paths, outDir, [360, 1280], { stub: true }),
    fonts: async (base, paths, opts) => checkFonts(await get(), base, paths, { stub: true, block: true, ...(opts?.widths ? { widths: opts.widths } : {}) }),
    daisyuiParts: (distDir) => partsMissingFromBuild(builtCss(distDir)),
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
  freeBytes: (dir) => {
    const s = statfsSync(dir)
    return s.bavail * s.bsize
  },
  isUp,
  fontFetch: httpFetch,
  toolVersion: () => toolVersion(),
  lockDir: tmpdir(),
})

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!

/** A page load that found no server: the preview process is gone, not the page broken. */
export const DROPPED = /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED)|ECONNREFUSED|ECONNRESET/

/** Free disk verify needs, GB: two npm ci, two builds and a Docker image fit with room to spare (#23). */
export const MIN_FREE_GB = 15

/** The threshold: the option, else ROLLOUT_MIN_FREE_GB, else MIN_FREE_GB. */
export function minFreeGb(option?: number, env: string | undefined = process.env['ROLLOUT_MIN_FREE_GB']): number {
  if (option !== undefined) return option
  const n = env === undefined || env === '' ? NaN : Number(env)
  return Number.isFinite(n) && n >= 0 ? n : MIN_FREE_GB
}

/** Page files that render `file`: itself if it is a route, else the pages of a layout it is. */
function pagesOf(report: Report, file: string): string[] {
  if (file.startsWith('src/pages/')) return [file]
  return report.layouts.find((l) => l.file === file)?.pages ?? []
}

/** Routes of the page files among `files` (dynamic routes left out). */
const routesOf = (files: string[]): string[] => files.filter((f) => isRoute(f) && !f.includes('[')).map((f) => norm(routeOf(f)))

/** Routes of an iframe detect found on a page, a layout or a component call site. */
const iframeRoutes = (report: Report, iframe: Report['iframes'][number]): string[] =>
  routesOf([iframe.file, ...(iframe.callSites ?? []).map((c) => c.file)].flatMap((f) => pagesOf(report, f)))

/** The routes of the pages detect knows have an embed: an iframe, or a widget's pages (dynamic routes left out). */
export const embedRoutes = (report: Report): Set<string> =>
  new Set([...report.iframes.flatMap((i) => iframeRoutes(report, i)), ...routesOf(report.widgets.flatMap((w) => w.pages))])

const FILTER_CLASS = /(?:^|\s)!?(?:grayscale|sepia|invert|blur|brightness-|contrast-|hue-rotate-|saturate-|drop-shadow)/

/**
 * Route -> service of the iframe there that had a CSS filter detect could see (inline style or a
 * Tailwind filter class). The first such iframe in the report wins a route.
 */
export function filterRoutes(report: Report): Map<string, ServiceSlug> {
  const routes = new Map<string, ServiceSlug>()
  for (const iframe of report.iframes) {
    if (!iframe.service || !(/(?:^|;)\s*filter\s*:/.test(iframe.style ?? '') || FILTER_CLASS.test(iframe.classes ?? ''))) continue
    for (const route of iframeRoutes(report, iframe)) if (!routes.has(route)) routes.set(route, iframe.service)
  }
  return routes
}

/** `name@version` for astro, vite and @tailwindcss/vite anywhere in `npm ls --json` output. */
/**
 * `npm ls --json` read from stdout (#128): npm exits 1 on a peer-range problem (ELSPROBLEMS) and
 * prints a log line on stderr, while the JSON on stdout stays complete. Throws when it is not JSON.
 * `note` says why npm exited non-zero, for the evidence.
 */
export function readNpmLs(res: ExecResult): { versions: string[]; note: string | null } {
  const json = res.stdout ?? res.out
  const versions = lsVersions(json)
  if (res.code === 0) return { versions, note: null }
  const error = (JSON.parse(json) as { error?: { code?: string; summary?: string } }).error
  return { versions, note: `exit ${res.code}${error?.code ? `, ${error.code}: ${(error.summary ?? '').split('\n')[0]}` : ''}` }
}

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

/** Whether `pkg` (a package.json text) depends on astro-consent: the banner is on that side. */
export function hasPackage(pkg: string): boolean {
  try {
    const json = JSON.parse(pkg) as Record<string, Record<string, unknown> | undefined>
    return ['dependencies', 'devDependencies'].some((f) => Object.hasOwn(json[f] ?? {}, PKG))
  } catch {
    return false
  }
}

/** The paths the Sentry commit may change (sentry-selfhost step 1): the bundle and the files report.sentry found the loads and hints in. */
export function sentryPaths(report: Report): (path: string) => boolean {
  const files = new Set<string>([SENTRY_FILE, ...(report.sentry?.loaders ?? []).map((l) => l.file), ...(report.sentry?.hints ?? []).map((h) => h.file)])
  return (path) => files.has(path)
}

/** The paths the fonts commit may change (fonts-selfhost step 1), from the report detect wrote on main. */
export function fontsPaths(report: Report): (path: string) => boolean {
  const files = new Set<string>([
    FONTS_CSS,
    ...(report.css.entry ? [report.css.entry] : []),
    ...(report.fonts?.locations ?? []).map((l) => l.file),
    ...(report.fonts?.csp ?? []).map((c) => c.file),
  ])
  return (path) => files.has(path) || path.startsWith(`${FONTS_DIR}/`)
}

/** Text of a fetch answer. */
const utf8 = (body: Uint8Array): string => new TextDecoder().decode(body)

/**
 * Runs C3 on the checkout `dir` (on a branch of FLOWS) for `report`. Pushes the branch first
 * (step 9 clones from GitHub), then runs the flow's steps and stops at the first failure. Throws,
 * before any step, when ROLLOUT_PORT_BASE is not a port, PortsBusy when another verify holds its
 * ports or one of them already answers (#87), when the disk has less free space than
 * `minFreeGb` (#23), when `dir` is not on a branch of FLOWS, or when a stray `<dir>-main` is not one of its worktrees.
 */
export async function verify(dir: string, report: Report, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const deps: VerifyDeps = { ...realDeps(), ...opts.deps }
  const ports = rolloutPorts()
  // #87: a second verify on these ports, or a server a killed run left on one, used to fail at step 3
  // after the push and both builds, logged like the site's own failure. Stop before anything instead.
  const release = lockPorts(deps.lockDir, ports)
  try {
    for (const port of [ports.docker, ports.main, ports.branch]) {
      if ((await deps.isUp(`http://127.0.0.1:${port}/`)) || (await deps.isUp(`http://localhost:${port}/`))) {
        throw new PortsBusy(
          `port ${port} already answers before verify starts: a preview or container left by a killed run? Find it with lsof -nP -iTCP:${port} -sTCP:LISTEN and stop it, or set ROLLOUT_PORT_BASE to a base at least 3 away`,
        )
      }
    }
    return await runVerify(dir, report, opts, deps, ports)
  } finally {
    release()
  }
}

async function runVerify(dir: string, report: Report, opts: VerifyOptions, deps: VerifyDeps, ports: Ports): Promise<VerifyResult> {
  const { exec } = deps
  const root = resolve(dir)
  const demo = opts.demo === true
  const out = opts.out ?? join(root, '.rollout')
  // #23: Docker failed with I/O errors twice in the expansion at 2.5 GB free. Stop before touching
  // anything. The demo builds no site, and CI runners have less than 15 GB to spare.
  if (!demo) {
    const need = minFreeGb(opts.minFreeGb)
    const free = deps.freeBytes(root) / 1e9
    if (free < need) {
      throw new Error(
        `${(Math.floor(free * 10) / 10).toFixed(1)} GB free on the disk holding ${root}, verify needs ${need} GB: delete node_modules and dist in site clones that are merged (live post-merge does this after a pass), then rerun; ROLLOUT_MIN_FREE_GB changes the threshold`,
      )
    }
  }
  const git = (...args: string[]) => exec('git', args, root)
  const flow: Flow = demo ? FLOWS['consent-banner'] : flowOf((await git('rev-parse', '--abbrev-ref', 'HEAD')).out.trim(), 'verify', root)
  const BRANCH = flow.branch
  const evidenceDir = statePath(out, 'evidence', BRANCH)
  const shotsDir = statePath(out, 'shots', BRANCH)
  // Evidence and screenshots from an earlier run must not pass for this one's.
  for (const d of [evidenceDir, shotsDir]) rmSync(d, { recursive: true, force: true })
  mkdirSync(evidenceDir, { recursive: true })

  const tool = deps.toolVersion()
  const steps: StepResult[] = []
  const record = (step: number, name: string, o: Outcome): boolean => {
    const evidence = o.lines.join('\n')
    writeFileSync(join(evidenceDir, `${step}-${name}.txt`), `${toolLine(tool)}\n\n${evidence}\n`)
    steps.push({ step, name, pass: o.pass, evidence, ...(o.skipped ? { skipped: true } : {}) })
    return o.pass
  }
  const restarts: string[] = []
  const finish = (): VerifyResult => {
    const result: VerifyResult = { pass: steps.length > 0 && steps.every((s) => s.pass), sha, tool, steps, ...(restarts.length ? { restarts } : {}) }
    writeFileSync(statePath(out, VERIFY_FILE, BRANCH), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  let sha: string | null = null

  const mainDir = demo ? null : `${root.replace(/\/+$/, '')}-main`
  /** Whether `mainDir` is listed by `git worktree list` as one of this clone's worktrees. */
  let staleWorktree = false
  if (!demo) {
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
    const remoteSha = headSha(remote.out, BRANCH)
    const pushedPath = statePath(out, PUSHED_FILE, BRANCH)
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
    if (sha) writeFileSync(statePath(out, PUSHED_FILE, BRANCH), `${sha}\n`)
  }

  // Step 8 runs on fonts-selfhost, and on consent-banner whenever the branch has the tool's fonts.css.
  const fontsCss = demo || !existsSync(join(root, FONTS_CSS)) ? null : readFileSync(join(root, FONTS_CSS), 'utf8')
  const selfHosts = isToolFontsCss(fontsCss)
  const runs = (name: StepName): boolean => flow.steps.includes(name) || (name === 'fonts' && selfHosts)
  // A self-hosting flow before the banner (a site without it on main): no banner is expected anywhere.
  let bannerOnMain = true
  if (!demo && flow.selfHosting) {
    const pkg = await git('show', 'origin/main:package.json')
    if (pkg.code !== 0) {
      record(0, 'main', { pass: false, lines: ['git show origin/main:package.json failed, so whether main has the banner is unknown:', tail(pkg.out)] })
      return finish()
    }
    bannerOnMain = hasPackage(pkg.out)
  }

  const ssr = demo || report.astro.output === 'server'
  const known = embedRoutes(report)
  const filters = filterRoutes(report)
  const expectFilter = filters.size ? (p: string) => filters.get(norm(p)) ?? null : undefined
  // CMS admin shells (src/pages/admin/, or Decap's public/admin/ copied to dist/admin/) never get the banner.
  const expectBanner = demo
    ? (p: string) => norm(p) !== '/utan-banner' && !p.startsWith(MISSING_PREFIX)
    : bannerOnMain
      ? (p: string) => !isCmsAdminRoute(p)
      : () => false
  const previews: Preview[] = []
  let checks = null as Checks | null
  const getChecks = async () => (checks ??= await deps.checks())
  let branch = null as Preview | null

  /**
   * Main's preview for one step (#20). It twice stopped answering mid-verify with nothing in its
   * log, and a rerun passed. `use` runs a check against it; when that throws a dropped connection
   * and main no longer answers, main is restarted once on the same port and the check runs again.
   * A second drop, any other error, or a main that still answers fails the step as before. The
   * branch's preview is never restarted: a crash there may be the wiring's doing.
   */
  const entryOf = (dir: string) => (ssr ? ssrEntry(dir).entry : undefined)
  const mainPreview = async (step: string, lines: string[]) => {
    let p = await deps.preview(mainDir!, ports.main, ssr, entryOf(mainDir!))
    previews.push(p)
    let restarted = false
    return {
      url: () => p.url,
      async use<T>(check: (url: string) => Promise<T>): Promise<T> {
        try {
          return await check(p.url)
        } catch (e) {
          const message = firstLine(e)
          if (restarted || !DROPPED.test(message) || (await deps.isUp(`${p.url}/`))) throw e
          restarted = true
          await p.stop()
          // The new preview starts the log afresh, and it is the only clue to why main stopped.
          let log = ''
          try {
            log = readFileSync(previewLog(ports.main), 'utf8')
          } catch {
            // no log (tests, or it was never written)
          }
          try {
            p = await deps.preview(mainDir!, ports.main, ssr, entryOf(mainDir!))
          } catch (again) {
            throw new Error(`main's preview stopped answering (${message}) and did not restart: ${firstLine(again)}`, { cause: again })
          }
          previews.push(p)
          lines.push(`main's preview stopped answering (${message}): restarted it once and checked main again`)
          if (log.trim()) lines.push("main's preview log before the restart:", ...tail(log, 10).split('\n').map((l) => `  ${l}`))
          restarts.push(`step ${step}: ${message}`)
          try {
            return await check(p.url)
          } catch (again) {
            throw new Error(`after restarting main's preview once: ${firstLine(again)}`, { cause: again })
          }
        }
      },
      stop: () => p.stop(),
    }
  }
  let paths: string[] = []
  let mapPages: string[] = []
  /** Registry requests main made, per page (step 3). */
  const mainBlocked = new Map<string, Set<string>>()
  /**
   * fonts-selfhost on a site without the banner on main: the registry requests main makes on a page
   * are the site's own, not the fonts commit's; they are noted and left out. Any other is still a
   * failure. With the banner on main (every other case) the results are returned as they are.
   */
  const commitName = BRANCH === SENTRY_BRANCH ? 'the Sentry commit' : 'the fonts commit'
  const mainsOwn = (results: RequestResult[], lines: string[]): RequestResult[] => {
    if (bannerOnMain) return results
    return results.map((r) => {
      const own = mainBlocked.get(norm(r.path)) ?? new Set<string>()
      const blocked = r.blocked.filter((u) => !own.has(u))
      if (blocked.length === r.blocked.length) return r
      lines.push(`${r.path}: ${r.blocked.length - blocked.length} registry request(s) main makes too (no banner on main): noted, not ${commitName}'s`)
      return { ...r, blocked, ok: r.banner === expectBanner(r.path) && r.banners <= 1 && blocked.length === 0 && r.errors.length === 0 }
    })
  }
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
      if (flow.selfHosting) {
        // The fonts and Sentry commits install nothing: package.json and the lockfile stay main's,
        // byte for byte, and only the files the plan writes or edits change.
        const sentry = BRANCH === SENTRY_BRANCH
        const mainPkg = await git('show', 'origin/main:package.json')
        const samePkg = mainPkg.code === 0 && mainPkg.out === branchPkg
        const sameLock = readFileSync(join(mainDir!, 'package-lock.json'), 'utf8') === readFileSync(join(root, 'package-lock.json'), 'utf8')
        const diff = await git('diff', '--name-only', 'origin/main...HEAD')
        const allowed = sentry ? sentryPaths(report) : fontsPaths(report)
        const changed = diff.out.split('\n').filter(Boolean)
        const extra = changed.filter((p) => !allowed(p))
        const own = sentry ? 'the Sentry bundle' : 'the fonts'
        lines.push(
          `package.json, main → branch: ${samePkg ? 'same' : `CHANGED (${commitName} must not touch it)`}`,
          `package-lock.json, main → branch: ${sameLock ? 'same' : `CHANGED (${commitName} must not touch it)`}`,
          `changed files (${changed.length}): ${diff.code === 0 ? (extra.length ? `NOT ONLY ${own.toUpperCase()}` : `only ${own}`) : 'git diff failed'}`,
          ...extra.map((p) => `  UNKNOWN ${p}`),
        )
        const ls: Record<string, string[]> = {}
        for (const [side, cwd] of [['main', mainDir!], ['branch', root]] as const) {
          try {
            const { versions, note } = readNpmLs(await exec('npm', NPM_LS, cwd))
            ls[side] = versions
            if (note) lines.push(`npm ls on ${side}: ${note}`)
          } catch {
            return { pass: false, lines: [...lines, `npm ls on ${side} gave no JSON`] }
          }
        }
        const same = JSON.stringify(ls['main']) === JSON.stringify(ls['branch'])
        lines.push(`npm ls astro vite @tailwindcss/vite: ${same ? 'same' : 'DIFFERENT'}`)
        return { pass: samePkg && sameLock && diff.code === 0 && extra.length === 0 && same, lines }
      }
      let site: Record<string, unknown> = {}
      try {
        site = JSON.parse(branchPkg) as Record<string, unknown>
      } catch {
        // the package.json comparison below reports it
      }
      const { allowed, unknown } = diffLock(readFileSync(join(mainDir!, 'package-lock.json'), 'utf8'), readFileSync(join(root, 'package-lock.json'), 'utf8'), PKG, site)
      lines.push('package-lock.json, main → branch:', ...allowed.map((l) => `  allowed ${l}`), ...unknown.map((l) => `  UNKNOWN ${l}`))
      const mainPkg = await git('show', 'origin/main:package.json')
      let pkgChanges: string[]
      try {
        pkgChanges = diffPackageJson(mainPkg.out, branchPkg, PKG)
      } catch (e) {
        pkgChanges = [`could not compare package.json with origin/main: ${(e as Error).message}`]
      }
      const update = BRANCH === UPDATE_BRANCH
      lines.push(
        `package.json, main → branch: ${pkgChanges.length ? 'CHANGED beyond the package' : update ? `only the ${PKG} spec changed` : `only ${PKG} added`}`,
        ...pkgChanges.map((l) => `  UNKNOWN ${l}`),
      )
      // The update commit is the install alone: the two package files, the package moved up.
      let updateOk = true
      if (update) {
        const diff = await git('diff', '--name-only', 'origin/main...HEAD')
        const changed = diff.out.split('\n').filter(Boolean)
        const extra = changed.filter((p) => p !== 'package.json' && p !== 'package-lock.json')
        let from: string | null = null
        let to: string | null = null
        try {
          from = installedOf(readFileSync(join(mainDir!, 'package-lock.json'), 'utf8'))?.version ?? null
          to = installedOf(readFileSync(join(root, 'package-lock.json'), 'utf8'))?.version ?? null
        } catch {
          // reported as (none) below
        }
        const up = from !== null && to !== null && compareVersions(to, from) > 0
        lines.push(
          `changed files (${changed.length}): ${diff.code === 0 ? (extra.length ? 'NOT ONLY package.json AND package-lock.json' : 'only package.json and package-lock.json') : 'git diff failed'}`,
          ...extra.map((p) => `  UNKNOWN ${p}`),
          `${PKG} on main → branch: ${from ?? '(none)'} → ${to ?? '(none)'}${up ? '' : ': NOT AN UPDATE'}`,
        )
        updateOk = diff.code === 0 && extra.length === 0 && up
      }
      const ls: Record<string, string[]> = {}
      for (const [side, cwd] of [['main', mainDir!], ['branch', root]] as const) {
        const res = await exec('npm', NPM_LS, cwd)
        try {
          const { versions, note } = readNpmLs(res)
          ls[side] = versions
          if (note) lines.push(`npm ls on ${side}: ${note}`)
        } catch {
          return { pass: false, lines: [...lines, `npm ls on ${side} gave no JSON (exit ${res.code}):`, tail(res.out)] }
        }
      }
      const same = JSON.stringify(ls['main']) === JSON.stringify(ls['branch'])
      lines.push(`npm ls astro vite @tailwindcss/vite: ${same ? 'same' : 'DIFFERENT'}`, `  main   ${ls['main']!.join(' ')}`, `  branch ${ls['branch']!.join(' ')}`)
      return { pass: unknown.length === 0 && pkgChanges.length === 0 && same && updateOk, lines }
    },

    async build() {
      const lines: string[] = []
      if (demo) lines.push('npm run build: skipped (demo)')
      else {
        const res = await exec('npm', ['run', 'build'], root)
        lines.push('npm ci: done in step 1', `npm run build exit ${res.code}`, tail(res.out))
        if (res.code !== 0) return { pass: false, lines }
      }
      // #93: the GlitchTip block renders only with PUBLIC_GLITCHTIP_DSN, which the build has not, so
      // the source is read instead. The bundle counts only when it is committed (git ls-files).
      let sentryOk = true
      if (!demo) {
        const tracked = (await git('ls-files', '--error-unmatch', SENTRY_FILE)).code === 0 && existsSync(join(root, SENTRY_FILE))
        const s = checkSentrySource(diskSite(root), tracked ? new Uint8Array(readFileSync(join(root, SENTRY_FILE))) : null)
        lines.push(...s.lines)
        sentryOk = s.pass
        // The Sentry flow's one job: its bundle must be there.
        if (BRANCH === SENTRY_BRANCH && !tracked) {
          lines.push(`${SENTRY_FILE} is not committed on ${SENTRY_BRANCH}: run.ts sentry writes it`)
          sentryOk = false
        }
      }
      // #101: a daisyUI include/exclude list without card, toggle or badge built a half-styled banner
      // that every later step passed. The self-hosting flows leave a live banner as it is, so it is not asked.
      if (flow.selfHosting) return { pass: sentryOk, lines }
      const missing = neededParts((await getChecks()).daisyuiParts(demo ? root : join(root, 'dist')), report.services.length > 0)
      lines.push(
        missing.length > 0
          ? `daisyUI parts the banner uses, missing from the built CSS: ${missing.join(', ')} (add them to the @plugin "daisyui" list)`
          : 'daisyUI parts the banner uses: all in the built CSS',
      )
      return { pass: missing.length === 0 && sentryOk, lines }
    },

    async requests() {
      const lines: string[] = []
      let mainResults: RequestResult[] = []
      if (!demo) {
        const res = await exec('npm', ['run', 'build'], mainDir!)
        if (res.code !== 0) return { pass: false, lines: ['npm run build failed on main:', tail(res.out)] }
      }
      if (ssr && !demo) {
        const b = ssrEntry(root)
        const m = ssrEntry(mainDir!)
        const say = (e: ReturnType<typeof ssrEntry>) => `${e.entry} (${e.from === 'start' ? 'the start script' : 'default'})`
        lines.push(b.entry === m.entry ? `SSR entry: ${say(b)}` : `SSR entry: branch ${say(b)}, main ${say(m)}`)
      }
      branch = await deps.preview(root, ports.branch, ssr, demo ? 'server/entry.mjs' : entryOf(root))
      previews.push(branch)
      const c = await getChecks()
      paths = await c.pages(branch.url, { distDir: demo ? root : join(root, 'dist'), ssr })
      lines.push(`pages (${paths.length}): ${paths.join(' ')}`)
      if (!paths.some((p) => norm(p) === '/')) return { pass: false, lines: [...lines, '"/" is not among the pages: the page list is broken'] }
      if (!demo) {
        const main = await mainPreview('3 requests', lines)
        mainResults = await main.use((url) => c.requests(url, paths, {}))
        const mainHost = new URL(main.url()).host
        baseline = new Set(mainResults.flatMap((r) => r.errors).map((e) => e.replaceAll(mainHost, new URL(branch!.url).host)))
        lines.push('main (expected RED: no banner, registry requested on map pages):', ...formatRequests(mainResults).map((l) => `  ${l}`))
        const green = [
          ...(mainResults.some((r) => r.banner) ? ['shows a banner'] : []),
          ...(mainResults.every((r) => r.blocked.length === 0) ? ['requests nothing from the registry'] : []),
        ]
        if (green.length) lines.push(`main already green: ${green.join(', ')} (noted, not a failure)`)
        await main.stop()
      }
      for (const r of mainResults) mainBlocked.set(norm(r.path), new Set(r.blocked))
      const results = mainsOwn(await c.requests(branch.url, paths, { baseline, expectBanner }), lines)
      lines.push('branch:', ...formatRequests(results).map((l) => `  ${l}`))
      // Step 4 clicks the banner, so a page meant to have none (demo: /utan-banner) is left out.
      mapPages = (await c.embedPages(branch.url, paths)).filter(expectBanner)
      const knownPages = new Set([...known, ...mapPages.map(norm)])
      // A detect miss is an embed the banner wiring left unwrapped: no banner, no wiring to miss.
      // Sentry's CDN (#93) is no embed: a request there fails the page above, never as a miss.
      const misses = bannerOnMain
        ? [...new Set([...mainResults, ...results].filter((r) => r.blocked.some((u) => !isSentryEntry(u)) && !knownPages.has(norm(r.path))).map((r) => r.path))]
        : []
      lines.push(`pages with an embed: ${mapPages.join(' ') || '(none)'}`, ...misses.map((p) => `detect miss: ${p}`))
      return { pass: results.length > 0 && results.every((r) => r.ok) && misses.length === 0, lines }
    },

    async 'consent-paths'() {
      const lines = [`pages with an embed: ${mapPages.join(' ') || '(none)'}`]
      const withEmbed = new Set(mapPages.map(norm))
      const lost = [...known].filter((r) => !withEmbed.has(r))
      lines.push(...lost.map((r) => `detect found an embed on ${r}, but the built page has no embed`))
      if (mapPages.length === 0) {
        const pass = report.classification !== 'consent' && lost.length === 0
        return { pass, lines: [...lines, pass ? 'no embed pages: nothing to check' : 'a consent site with no embed on any built page'] }
      }
      const r = consentPathLines(await (await getChecks()).consentPaths(branch!.url, mapPages, { expectFilter }))
      return { pass: r.pass && lost.length === 0, lines: [...lines, ...r.lines] }
    },

    async clip() {
      if (!bannerOnMain) return { pass: true, skipped: true, lines: ['skipped: main has no banner, so there is no banner button to measure'] }
      const c = await getChecks()
      const rows = await c.clip(branch!.url, [...new Set(['/', ...mapPages])])
      // A page that already scrolls sideways on main (a site's own wide hamburger) is not the
      // banner's doing: main is measured for those paths, and only a wider branch fails.
      // Site-wide styles (daisyUI's scrollbar and :root background, site 1243331215) are compared with
      // main too: a difference shows on every page, and the screenshots cannot show a scrollbar.
      const mainW = new Map<string, number>()
      const wide = rows.filter((r) => r.kind === 'page' && r.clipped)
      let rootDiff: string[] | null = null
      const mainLines: string[] = []
      // #46: each placeholder must be about as tall as the iframe it replaced (site 1228881255).
      let heights: ReturnType<typeof compareEmbedHeights> | null = null
      if (!demo) {
        const main = await mainPreview('5 clip', mainLines)
        try {
          if (wide.length)
            for (const m of await main.use((url) => c.clip(url, [...new Set(wide.map((r) => r.path))])))
              if (m.kind === 'page') mainW.set(`${m.path} ${m.width}`, m.w)
          rootDiff = diffRootStyles(await main.use((url) => c.rootStyles(url)), await c.rootStyles(branch!.url))
          if (mapPages.length) heights = compareEmbedHeights(await main.use((url) => c.embedBoxes(url, mapPages)), await c.embedBoxes(branch!.url, mapPages))
        } finally {
          await main.stop()
        }
      }
      const lines: string[] = [...mainLines]
      for (const r of rows) {
        const onMain = r.kind === 'page' && r.clipped ? mainW.get(`${r.path} ${r.width}`) : undefined
        if (onMain !== undefined && onMain >= r.w) r.clipped = false
        const why = `${r.over ? ' (text overflows)' : ''}${r.out ? ' (sticks out)' : ''}${r.covered ? ' (covered by another element)' : ''}${r.cut ? ' (cut off by an overflow:hidden ancestor)' : ''}`
        const main = onMain === undefined ? '' : r.clipped ? ` (main ${onMain}px)` : ` (main ${onMain}px too: not the banner)`
        lines.push(`${r.path} ${r.width}px ${r.kind} "${r.button}" ${r.w}px in ${r.boxW}px ${r.clipped ? `CLIPPED${why}` : 'ok'}${main}`)
      }
      const measured = rows.some((r) => r.kind === 'button')
      if (!measured) lines.push('no banner or embed button was measured')
      if (rootDiff === null) lines.push('root styles: not compared (no main)')
      else if (rootDiff.length === 0) lines.push('root styles on /: same as main')
      else lines.push(...rootDiff.map((d) => `root styles on / differ from main: ${d}`))
      if (heights) {
        for (const h of heights.rows) lines.push(`${h.path} ${h.width}px ${h.service} ${h.index}: ${h.branchH}px tall, main ${h.mainH}px ${h.ok ? 'ok' : 'SHORTER'}`)
        lines.push(...heights.notes)
      } else if (mapPages.length) lines.push('embed heights: not compared (no main)')
      return { pass: measured && rows.every((r) => !r.clipped) && !rootDiff?.length && (heights?.rows.every((h) => h.ok) ?? true), lines }
    },

    async contrast() {
      const rows = await (await getChecks()).contrast(branch!.url, paths)
      const lines = rows.map(formatContrast)
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
      const files = await (await getChecks()).shots(branch!.url, [...new Set(['/', ...mapPages, ...(missing ? [missing] : [])])], shotsDir)
      return { pass: files.length > 0, lines: [`${files.length} files in ${shotsDir}`, ...files] }
    },

    async fonts() {
      if (!selfHosts || fontsCss === null) {
        return { pass: false, lines: [`${FONTS_CSS} is missing or not this tool's (no "${FONTS_MARKER}" in its header): run.ts fonts writes it`] }
      }
      const declared = parseFontsCss(fontsCss)
      const families = [...new Set(declared.map((f) => f.family))]
      const lines = [`${FONTS_CSS}: ${declared.length} faces, ${families.join(', ') || 'no family'}`]
      if (declared.length === 0) return { pass: false, lines: [...lines, 'no @font-face in it'] }
      // a: nothing built still names Google Fonts (fonts.css's own header is a CSS comment).
      const distDir = join(root, 'dist')
      const mentions = distMentions(distDir)
      lines.push(mentions.length ? 'dist/ names Google Fonts:' : 'dist/: no Google Fonts host outside comments', ...mentions.map((m) => `  ${m}`))
      // b, c: every visitor page at 360 and 1280 px, Google Fonts blocked and counted.
      const visitor = fontsCheckPaths(paths)
      const pages = await (await getChecks()).fonts(branch!.url, visitor.paths)
      const judged = pages.map((p) => judgeFontsPage(p, declared))
      lines.push(...visitor.lines, ...judged.flatMap((j) => j.lines))
      // d: every character shown in a self-hosted family falls in its kept ranges. Google's whole
      // answer tells a character it never had (a fallback on main too) from one left out.
      let google: Face[] | null = null
      const url = css2UrlOf(fontsCss)
      try {
        if (!url) throw new Error(`no css2 URL in the header of ${FONTS_CSS}`)
        const res = await deps.fontFetch(url, { 'user-agent': CHROME_UA })
        if (res.status !== 200) throw new Error(`${url} answered ${res.status}`)
        google = parseCss2(utf8(res.body))
      } catch (e) {
        lines.push(`Google's faces unknown (${firstLine(e)}): every character outside the kept ranges counts`)
      }
      const client = ssr && existsSync(join(distDir, 'client')) ? join(distDir, 'client') : distDir
      // The DOM is strict; the shipped JS/JSON strings are notes (a library string may never show).
      const coverage = checkCoverage(pageTexts(pages), declared, google)
      const covLines = [...coverageLines(coverage), ...shippedNotes(checkCoverage(shippedTexts(pages, shippedStrings(client)), declared, google))]
      lines.push(covLines.length ? 'character coverage:' : 'character coverage: every character shown is in a kept face', ...covLines.map((l) => `  ${l}`))
      return { pass: mentions.length === 0 && pages.length > 0 && judged.every((j) => j.ok) && coverage.missing.length === 0, lines }
    },

    async docker() {
      if (demo) return { pass: true, skipped: true, lines: ['skipped (demo)'] }
      const local = (await git('rev-parse', 'HEAD')).out.trim()
      const remote = headSha((await git('ls-remote', 'origin', `refs/heads/${BRANCH}`)).out, BRANCH)
      if (!local || remote !== local) return { pass: false, lines: [`origin/${BRANCH} is ${remote || '(missing)'}, HEAD is ${local}: push the branch first`] }
      const repoUrl = (await git('remote', 'get-url', 'origin')).out.trim()
      if (!ORIGIN.test(repoUrl)) return { pass: false, lines: [`origin is ${repoUrl || '(none)'}, not a github.com/visionmediahq repo: step 9 clones only from there`] }
      const lines = [`origin/${BRANCH} = HEAD = ${local}`]
      const c = await getChecks()
      const result = await deps.docker(repoUrl, BRANCH, async (url) => {
        const results = mainsOwn(await c.requests(url, paths, { baseline: rebase(url), expectBanner }), lines)
        lines.push('step 3 against the container:', ...formatRequests(results).map((l) => `  ${l}`))
        let pass = results.length > 0 && results.every((r) => r.ok)
        if (mapPages.length && runs('consent-paths')) {
          const r = consentPathLines(await c.consentPaths(url, mapPages, { expectFilter }))
          lines.push('step 4 against the container:', ...r.lines.map((l) => `  ${l}`))
          pass &&= r.pass
        }
        if (runs('fonts') && fontsCss !== null) {
          // The container's own server answers the woff2 files now (Coolify serves this image).
          const visitor = fontsCheckPaths(paths)
          const judged = (await c.fonts(url, visitor.paths, { widths: [1280] })).map((p) => judgeFontsPage(p, parseFontsCss(fontsCss)))
          lines.push('step 8 requests against the container (1280 px):', ...[...visitor.lines, ...judged.flatMap((j) => j.lines)].map((l) => `  ${l}`))
          pass &&= judged.length > 0 && judged.every((j) => j.ok)
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
      if (!runs(name)) {
        record(i + 1, name, { pass: true, skipped: true, lines: [`skipped: ${flow.skipWhy}`] })
        continue
      }
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

/** The sha of exactly refs/heads/<branch> in `git ls-remote` output ('' when absent). */
function headSha(out: string, branch: string): string {
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/heads/${branch}`) return sha ?? ''
  }
  return ''
}

/** What run.ts prints: the tool line, each step with its evidence, then formatVerify. */
export function verifyOutput(result: VerifyResult): string[] {
  return [
    toolLine(result.tool),
    ...result.steps.flatMap((s) => [
      `--- step ${s.step} ${s.name}: ${s.skipped ? 'skipped' : s.pass ? 'pass' : 'FAIL'}`,
      ...(s.skipped ? [] : [s.evidence.replace(/^/gm, '  ')]),
    ]),
    ...formatVerify(result),
  ]
}

/** One line per step, as run.ts prints them. */
export function formatVerify(result: VerifyResult): string[] {
  return [
    ...result.steps.map((s) => `step ${s.step} ${s.name}: ${s.skipped ? 'skipped' : s.pass ? 'pass' : 'FAIL'}`),
    ...(result.restarts ?? []).map((r) => `main preview restarted: ${r}`),
    `verify: ${result.pass ? 'PASS' : 'FAIL'}`,
  ]
}
