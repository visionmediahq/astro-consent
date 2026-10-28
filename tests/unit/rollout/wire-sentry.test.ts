// Self-hosting Sentry's browser bundle (#93): wire's last commit on consent-banner. Nothing reaches
// the network: the bundle is a stand-in, hashed by the test, and the real hash check is exercised
// with a recorded answer that does not match it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectSentry } from '../../../ci/rollout/detect/sentry'
import { SENTRY_CDN_FILE, SENTRY_FILE, SENTRY_SRC, SENTRY_SRI, SENTRY_VERSION } from '../../../ci/rollout/lib/sentry'
import { diskSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import { parseWireArgs, runDetect, runWire } from '../../../ci/rollout/run'
import { applyEdits } from '../../../ci/rollout/wire/engine'
import { FONTS_COMMIT_MESSAGE } from '../../../ci/rollout/wire/fonts'
import { BRANCH, COMMIT_MESSAGE } from '../../../ci/rollout/wire/index'
import { commitSentry, fetchSentryBundle, planSentry, SENTRY_COMMIT_MESSAGE, sentryFiles, sri384 } from '../../../ci/rollout/wire/sentry'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const BUNDLE = new TextEncoder().encode(`/*! @sentry/browser ${SENTRY_VERSION} (test) */\nvar Sentry={};\n`)
const bundle = async () => BUNDLE

function memSite(files: Record<string, string>): SiteFiles {
  return {
    root: '/mem',
    list: (glob) => Object.keys(files).filter((p) => globToRegExp(glob).test(p)).sort(),
    read: (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`no such file: ${path}`)
      return text
    },
    exists: (path) => path in files,
  }
}
const FM = '---\nconst glitchtipDsn = import.meta.env.PUBLIC_GLITCHTIP_DSN\n---\n'
const page = (block: string) => `${FM}<html>\n  <head>\n    {glitchtipDsn && (\n      <>\n        ${block}\n      </>\n    )}\n  </head>\n  <body />\n</html>\n`
const STARTER = `<script
          is:inline
          src="https://cdn.jsdelivr.net/npm/@sentry/browser@8/build/bundle.min.js"
          crossorigin="anonymous"
        ></script>`
const withLayout = (block: string) => memSite({ 'src/layouts/Base.astro': page(block) })
const planOf = async (site: SiteFiles) => planSentry(site, { sentry: detectSentry(site) }, { bundle })
const layoutAfter = async (block: string): Promise<string> => {
  const site = withLayout(block)
  const plan = await planOf(site)
  if (!plan.ok) throw new Error(JSON.stringify(plan.refusals))
  return applyEdits(site.read('src/layouts/Base.astro'), plan.edits)
}

describe('the pinned bundle', () => {
  test('the newest 8.x, from Sentry\'s CDN, at public/js/ and /js/', () => {
    expect(SENTRY_VERSION).toBe('8.55.2')
    expect(SENTRY_CDN_FILE).toBe('https://browser.sentry-cdn.com/8.55.2/bundle.min.js')
    expect(SENTRY_FILE).toBe('public/js/sentry-8.55.2.min.js')
    expect(SENTRY_SRC).toBe('/js/sentry-8.55.2.min.js')
    expect(SENTRY_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/)
  })

  test('fetchSentryBundle returns the bytes that hash to the recorded SRI', async () => {
    const asked: string[] = []
    const fetch = async (url: string) => (asked.push(url), { status: 200, contentType: 'application/javascript', body: BUNDLE })
    expect(await fetchSentryBundle(fetch, sri384(BUNDLE))).toBe(BUNDLE)
    expect(asked).toEqual([SENTRY_CDN_FILE])
  })

  test('refuses an answer that does not hash to the recorded SRI, a non-200 and a failed request', async () => {
    const answer = (status: number) => async () => ({ status, contentType: 'application/javascript', body: BUNDLE })
    await expect(fetchSentryBundle(answer(200))).rejects.toThrow(`hashes to ${sri384(BUNDLE)}, not the recorded ${SENTRY_SRI}`)
    await expect(fetchSentryBundle(answer(404), sri384(BUNDLE))).rejects.toThrow(`${SENTRY_CDN_FILE} answered 404`)
    await expect(
      fetchSentryBundle(async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow(`${SENTRY_CDN_FILE} failed: offline`)
  })
})

describe('planSentry: the edits', () => {
  test("the starter's jsDelivr element: the local src, crossorigin gone, the rest as it was", async () => {
    expect(await layoutAfter(STARTER)).toBe(page(`<script
          is:inline
          src="/js/sentry-8.55.2.min.js"
        ></script>`))
  })

  test('Sentry CDN with defer, integrity and crossorigin on one line: defer stays', async () => {
    const tag = `<script is:inline defer src="https://browser.sentry-cdn.com/8.55.0/bundle.min.js" integrity="sha384-x" crossorigin="anonymous"></script>`
    expect(await layoutAfter(tag)).toBe(page('<script is:inline defer src="/js/sentry-8.55.2.min.js"></script>'))
  })

  test('async, data-dsn and onload stay', async () => {
    const tag = `<script is:inline async src="https://browser.sentry-cdn.com/8.55.0/bundle.min.js" crossorigin="anonymous" data-dsn={glitchtipDsn} onload="window.Sentry && Sentry.init({ dsn: this.dataset.dsn })"></script>`
    expect(await layoutAfter(tag)).toBe(
      page('<script is:inline async src="/js/sentry-8.55.2.min.js" data-dsn={glitchtipDsn} onload="window.Sentry && Sentry.init({ dsn: this.dataset.dsn })"></script>'),
    )
  })

  test('an inline script that adds the element: the literal, and the integrity and crossOrigin lines', async () => {
    const block = `<script is:inline define:vars={{ glitchtipDsn }}>
          const script = document.createElement('script')
          script.src = 'https://browser.sentry-cdn.com/8.55.2/bundle.min.js'
          script.integrity =
            '${SENTRY_SRI}'
          script.crossOrigin = 'anonymous'
          script.onload = () => Sentry.init({ dsn: glitchtipDsn })
          document.head.appendChild(script)
        </script>`
    expect(await layoutAfter(block)).toBe(
      page(`<script is:inline define:vars={{ glitchtipDsn }}>
          const script = document.createElement('script')
          script.src = '/js/sentry-8.55.2.min.js'
          script.onload = () => Sentry.init({ dsn: glitchtipDsn })
          document.head.appendChild(script)
        </script>`),
    )
  })

  test('a preconnect to the CDN in the block (site 1334143636) is cut with the load, its line and all', async () => {
    const block = `<link rel="preconnect" href="https://browser.sentry-cdn.com" crossorigin="anonymous" />
        <script is:inline defer src="https://browser.sentry-cdn.com/8.55.0/bundle.min.js" crossorigin="anonymous"></script>`
    expect(await layoutAfter(block)).toBe(page('<script is:inline defer src="/js/sentry-8.55.2.min.js"></script>'))
  })

  test('a dns-prefetch to jsDelivr outside the block (a client site) is cut too', async () => {
    const text = `${FM}<html>\n  <head>\n    <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />\n    <meta charset="utf-8" />\n    {glitchtipDsn && (\n      <>\n        ${STARTER}\n      </>\n    )}\n  </head>\n</html>\n`
    const site = memSite({ 'src/layouts/Base.astro': text })
    const plan = await planOf(site)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const after = applyEdits(text, plan.edits)
    expect(after).not.toContain('jsdelivr')
    expect(after).toContain('  <head>\n    <meta charset="utf-8" />\n')
    expect(plan.notes.join('\n')).toContain('1 resource hint(s) to the CDN cut')
  })

  test('the plan holds the bundle at public/js/ and says what it did; detect afterwards sees a local copy', async () => {
    const site = withLayout(STARTER)
    const plan = await planOf(site)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.file).toEqual({ path: SENTRY_FILE, bytes: BUNDLE })
    expect(plan.notes[0]).toBe('sentry: 1 load(s) of the bundle from cdn.jsdelivr.net 8 → /js/sentry-8.55.2.min.js (8.55.2), in src/layouts/Base.astro:10')
    const after = memSite({ 'src/layouts/Base.astro': applyEdits(site.read('src/layouts/Base.astro'), plan.edits), [SENTRY_FILE]: new TextDecoder().decode(BUNDLE) })
    expect(detectSentry(after)).toEqual({ status: 'self-hosted', loaders: [], selfHosted: [SENTRY_SRC], reasons: [], hints: [] })
  })
})

describe('planSentry refuses, with nothing planned', () => {
  const refused = async (site: SiteFiles, report: Parameters<typeof planSentry>[1], b = bundle) => {
    const plan = await planSentry(site, report, { bundle: b })
    expect(plan.ok).toBe(false)
    return plan.ok ? [] : plan.refusals.map((r) => r.reason)
  }

  test('a report stored before Sentry detection', async () => {
    expect(await refused(withLayout(STARTER), {})).toEqual(['the report was stored before Sentry detection: run detect again'])
  })

  test('nothing to self-host, or a site that needs a look', async () => {
    const none = memSite({ 'src/layouts/Base.astro': '<html />\n' })
    expect(await refused(none, { sentry: detectSentry(none) })).toEqual(['no Sentry CDN load to self-host (status none)'])
    const odd = withLayout('<script is:inline src="https://browser.sentry-cdn.com/7.1.0/bundle.min.js"></script>')
    expect((await refused(odd, { sentry: detectSentry(odd) }))[0]).toMatch(/^needs a look: .*major 7/)
  })

  test('the bundle file already exists', async () => {
    const site = memSite({ 'src/layouts/Base.astro': page(STARTER), [SENTRY_FILE]: 'x' })
    expect(await refused(site, { sentry: detectSentry(site) })).toEqual([`${SENTRY_FILE} already exists`])
  })

  test('a report that no longer matches the checkout', async () => {
    const before = withLayout(STARTER)
    const moved = memSite({ 'src/layouts/Base.astro': `<!-- moved -->\n${page(STARTER)}` })
    expect(await refused(moved, { sentry: detectSentry(before) })).toEqual(['report.sentry no longer matches the checkout: run detect again'])
  })

  test('a bundle that fails its hash check', async () => {
    const site = withLayout(STARTER)
    const reasons = await refused(site, { sentry: detectSentry(site) }, async () => {
      throw new Error('hashes to sha384-x, not the recorded sha384-y: nothing written')
    })
    expect(reasons).toEqual(['hashes to sha384-x, not the recorded sha384-y: nothing written'])
  })
})

// ── on disk: run.ts wire ───────────────────────────────────────────────────────────────────

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function treeOf(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.name.endsWith('.txt')) out.set(relative(dir, full).split(sep).join('/').slice(0, -'.txt'.length), readFileSync(full, 'utf8'))
    }
  }
  visit(dir)
  return out
}
/** A clone of a bare origin whose main holds `tree`. */
function checkout(tree: Map<string, string>): string {
  const origin = temp('sentry-origin-')
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = temp('sentry-seed-')
  git(seed, 'init', '-q', '-b', 'main')
  for (const [path, t] of tree) {
    mkdirSync(dirname(join(seed, path)), { recursive: true })
    writeFileSync(join(seed, path), t)
  }
  git(seed, 'add', '-A')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.se', 'commit', '-q', '-m', 'site')
  git(seed, 'push', '-q', origin, 'main')
  const parent = temp('sentry-clone-')
  git(parent, 'clone', '-q', origin, 'site')
  const dir = join(parent, 'site')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@example.se')
  return dir
}
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all')
const noPrs = async (): Promise<string[]> => []
/** The pilot site 1218869363: the starter's jsDelivr element, and Google Fonts. */
const pilotDir = (): string => checkout(treeOf(join(FIXTURES, 'site-1218869363', 'before')))

describe('run.ts wire: the Sentry bundle as the last commit on consent-banner', { timeout: 20_000 }, () => {
  test('parseWireArgs: on by default, --no-sentry skips it', () => {
    expect(parseWireArgs(['site'])).toMatchObject({ dir: 'site', sentry: true })
    expect(parseWireArgs(['site', '--no-sentry'])).toMatchObject({ sentry: false, fonts: true })
  })

  test('banner, then the Sentry commit with only the layout and the bundle (--no-fonts)', async () => {
    const dir = pilotDir()
    const report = runDetect(dir, ['site-1218869363.se'])
    expect(report.sentry?.status).toBe('wire')
    const { code, output } = await runWire(dir, { dryRun: false, fonts: false, sentryBundle: bundle, install: () => {}, openPrs: noPrs })
    expect(code).toBe(0)
    expect(output).toContain(`committed on ${BRANCH} (2 commits)`)
    expect(git(dir, 'log', '-2', '--format=%s').split('\n')).toEqual([SENTRY_COMMIT_MESSAGE, COMMIT_MESSAGE])
    expect(git(dir, 'rev-parse', 'HEAD~2')).toBe(git(dir, 'rev-parse', 'origin/main'))
    expect(git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').sort()).toEqual([SENTRY_FILE, 'src/layouts/Base.astro'])
    // The banner commit is the banner wiring alone: expected/ of the pilot fixture.
    const expected = treeOf(join(FIXTURES, 'site-1218869363', 'expected'))
    for (const [path, want] of expected) expect(execFileSync('git', ['show', `HEAD~1:${path}`], { cwd: dir, encoding: 'utf8' }), path).toBe(want)
    const layout = readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')
    expect(layout).not.toContain('jsdelivr')
    expect(layout).toContain(`src="${SENTRY_SRC}"`)
    expect(layout).toContain('<ConsentBanner />')
    expect(readFileSync(join(dir, SENTRY_FILE))).toEqual(Buffer.from(BUNDLE))
    expect(status(dir)).toBe('')
  })

  test('with the fonts: three commits, banner, fonts, Sentry', async () => {
    const dir = pilotDir()
    runDetect(dir, ['site-1218869363.se'])
    const css = readFileSync(join(FIXTURES, 'fonts-wire', 'css2', 'figtree.css.txt'), 'utf8')
    const fontsUrl = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@100;200;300;400&family=Poppins:wght@300;400&display=swap'
    const fetch = async (url: string) => {
      const enc = (s: string) => new TextEncoder().encode(s)
      if (url === fontsUrl) return { status: 200, contentType: 'text/css', body: enc(css) }
      if (url.includes('fonts.gstatic.com')) return { status: 200, contentType: 'font/woff2', body: enc(`wOF2\u0000${url.length}`) }
      if (url.includes('/ofl/')) return { status: 200, contentType: 'text/plain', body: enc('Copyright 2020 x\n\nSIL Open Font License, Version 1.1.\n') }
      return { status: 404, contentType: 'text/plain', body: enc('') }
    }
    const { code, output } = await runWire(dir, { dryRun: false, fetch, now: new Date('2026-10-28T12:00:00Z'), sentryBundle: bundle, install: () => {}, openPrs: noPrs })
    expect(code, output).toBe(0)
    expect(output).toContain(`committed on ${BRANCH} (3 commits)`)
    expect(git(dir, 'log', '-3', '--format=%s').split('\n')).toEqual([SENTRY_COMMIT_MESSAGE, FONTS_COMMIT_MESSAGE, COMMIT_MESSAGE])
    expect(git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').sort()).toEqual([SENTRY_FILE, 'src/layouts/Base.astro'])
    const layout = readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')
    expect(layout).not.toContain('fonts.g')
    expect(layout).not.toContain('jsdelivr')
    expect(status(dir)).toBe('')
  })

  test('--no-sentry: no request, the CDN load stays', async () => {
    const dir = pilotDir()
    runDetect(dir, ['site-1218869363.se'])
    let asked = 0
    const { code, output } = await runWire(dir, { dryRun: false, fonts: false, sentry: false, sentryBundle: async () => (asked++, BUNDLE), install: () => {}, openPrs: noPrs })
    expect(code).toBe(0)
    expect(output).toContain(`committed on ${BRANCH}\n`)
    expect(asked).toBe(0)
    expect(readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')).toContain('cdn.jsdelivr.net/npm/@sentry/')
  })

  test('a refused Sentry plan refuses the whole wire (exit 3, nothing written) and says how to wire without it', async () => {
    const dir = pilotDir()
    runDetect(dir, ['site-1218869363.se'])
    const { code, output } = await runWire(dir, {
      dryRun: false,
      fonts: false,
      sentryBundle: async () => {
        throw new Error('offline')
      },
      install: () => {},
      openPrs: noPrs,
    })
    expect(code).toBe(3)
    expect(output).toContain('wire: sentry bundle refused, nothing was written (wire --no-sentry wires without it)')
    expect(output).toContain('offline')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(status(dir)).toBe('')
  })

  test('a report stored before Sentry detection is refused unless --no-sentry', async () => {
    const dir = pilotDir()
    const report = runDetect(dir, ['site-1218869363.se'])
    const { sentry: _, ...old } = report
    writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify(old))
    const { code, output } = await runWire(dir, { dryRun: true, fonts: false, sentryBundle: bundle })
    expect(code).toBe(3)
    expect(output).toContain('the report was stored before Sentry detection: run detect again')
    expect((await runWire(dir, { dryRun: true, fonts: false, sentry: false })).code).toBe(0)
  })

  test('--dry-run shows the layout diff and the bundle as a new file, writes nothing', async () => {
    const dir = pilotDir()
    runDetect(dir, ['site-1218869363.se'])
    const { code, output } = await runWire(dir, { dryRun: true, fonts: false, sentryBundle: bundle })
    expect(code).toBe(0)
    expect(output).toContain('-          src="https://cdn.jsdelivr.net/npm/@sentry/browser@8/build/bundle.min.js"')
    expect(output).toContain(`+          src="${SENTRY_SRC}"`)
    expect(output).toMatch(new RegExp(`new +${SENTRY_FILE.replace(/\./g, '\\.')} \\(${BUNDLE.length} bytes\\)`))
    expect(status(dir)).toBe('')
    expect(existsSync(join(dir, SENTRY_FILE))).toBe(false)
  })
})

describe('commitSentry', { timeout: 20_000 }, () => {
  test('a layout changed since planning: nothing written', async () => {
    const dir = pilotDir()
    const report = runDetect(dir, ['site-1218869363.se'])
    const site = diskSite(dir)
    const plan = await planSentry(site, report, { bundle })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const files = sentryFiles((p) => site.read(p), plan)
    writeFileSync(join(dir, 'src/layouts/Base.astro'), 'changed\n')
    expect(() => commitSentry(dir, files, { branch: 'x' })).toThrow(/src\/layouts\/Base\.astro changed since it was planned, nothing written/)
    expect(existsSync(join(dir, SENTRY_FILE))).toBe(false)
  })
})
