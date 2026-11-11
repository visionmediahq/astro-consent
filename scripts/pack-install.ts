// Proves the package works from a real node_modules: npm pack → install the tarball into a copy of
// the demo with a given Astro version → build → assert the banner and its CSS are there → build
// once more per form of <script> in a <ConsentWidget> slot and assert that build fails (#27) →
// start `astro dev` and load the page's scripts, failing on a dependency pre-bundling error.
// Usage: npm run test:pack -- <astro version> <@astrojs/node version>
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, copyDemo } from './demo-copy'

const [astroVersion, adapterVersion] = process.argv.slice(2)
if (!astroVersion || !adapterVersion) {
  console.error('usage: npm run test:pack -- <astro version> <@astrojs/node version>   e.g. 6.1.6 10.0.4')
  process.exit(2)
}

const FORBIDDEN_SCRIPTS = ['prepare', 'preinstall', 'install', 'postinstall', 'prepack', 'build']
let tarball = ''
let dir = ''

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`pack-install: ${message}`)
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } })
  assert(result.status === 0, `\`${command} ${args.join(' ')}\` failed with exit code ${result.status}`)
}

// The slot check (src/widget.ts) runs on the output of Astro.slots.render. Where a version of
// Astro puts a slot's <script> is its own business, so each version must prove the build fails.
const WIDGET_SLOT_SCRIPTS = ['<script>console.log(1)</script>', '<script is:inline src="https://elfsightcdn.com/platform.js"></script>']
const SLOT_ERROR = 'no <script> in the slot'

function widgetPage(slot: string): string {
  return [
    '---',
    "import ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'",
    'export const prerender = true',
    '---',
    '<html><head><title>t</title></head><body>',
    `<ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="x"><div class="elfsight-app-x" data-elfsight-app-lazy></div>${slot}</ConsentWidget>`,
    '</body></html>',
  ].join('\n')
}

const ANSI = /\u001b\[[0-9;]*m/g
const FETCH_TIMEOUT = 15_000

/**
 * `astro dev` from a real node_modules: load the demo's home page and every module its scripts
 * import, as a browser would, so Vite pre-bundles what the page uses. On Astro 6 (Vite 7, esbuild
 * optimizer) pre-bundling the client script fails with "Could not resolve
 * virtual:astro-consent/config" unless the integration excludes the package from optimizeDeps.
 * Astro 7 (Vite 8) never had that error, so there this only proves the excluded package still
 * loads. The repo's own tests can't see it: the demo links the package, and Vite doesn't
 * pre-bundle linked packages.
 */
async function assertDevServerLoads(cwd: string): Promise<void> {
  const port = 4391
  // --ignore-lock keeps the server in the foreground: Astro 7 otherwise detects an AI agent
  // (CLAUDECODE, AI_AGENT, …) and moves it to the background with its log in .astro/, where this
  // check would never see an error. Astro 6 ignores the flag.
  const server = spawn('npx', ['astro', 'dev', '--port', String(port), '--ignore-lock'], {
    cwd,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
    // Own process group, so one kill stops npx and the astro process it started
    detached: true,
  })
  let raw = ''
  server.stdout.on('data', (chunk) => (raw += chunk))
  server.stderr.on('data', (chunk) => (raw += chunk))
  const output = () => raw.replace(ANSI, '')
  const exited = new Promise((resolve) => server.once('exit', resolve))
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const get = (url: string) =>
    fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }).then((res) => (res.ok ? res.text() : ''), () => '')
  try {
    // Astro moves to the next port when this one is taken; read the one it printed.
    let origin = ''
    for (let i = 0; i < 60 && !origin; i++) {
      await wait(500)
      origin = output().match(/http:\/\/localhost:\d+/)?.[0] ?? ''
    }
    assert(origin, `astro dev printed no local URL:\n${output()}`)
    let html = ''
    for (let i = 0; i < 30 && !html; i++) {
      html = await get(`${origin}/`)
      if (!html) await wait(500)
    }
    assert(html.includes('data-consent-banner'), `dev server did not serve the banner:\n${output()}`)

    // Walk the page's module graph: scripts, then the absolute imports Vite rewrote them to.
    const seen = new Set<string>()
    let queue = [...html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)].map((match) => match[1]!)
    while (queue.length > 0) {
      const next: string[] = []
      for (const path of queue) {
        if (seen.has(path)) continue
        seen.add(path)
        const code = await get(origin + path)
        for (const match of code.matchAll(/(?:from|import)\s*["'](\/[^"']+)["']/g)) next.push(match[1]!)
      }
      queue = next
    }
    // The optimizer runs after the first requests; give it time to report.
    await wait(5000)
    assert(!/Could not resolve|error while updating dependencies/.test(output()), `astro dev failed to pre-bundle a dependency:\n${output()}`)
    // Without this the check would pass if the walk never reached the package's client script
    const loaded = [...seen].filter((path) => path.includes('astro-consent'))
    assert(loaded.length > 0, `the dev page loaded no astro-consent module; loaded:\n${[...seen].join('\n')}`)
  } finally {
    // The group is gone if the server already exited
    try {
      if (server.pid) process.kill(-server.pid)
    } catch {}
    // Let it stop writing node_modules/.vite before the copy is removed
    await Promise.race([exited, wait(5000)])
  }
}

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' }))
  tarball = join(REPO_ROOT, packed[0].filename)

  dir = copyDemo('consent', { linkNodeModules: false })
  const css = readFileSync(join(dir, 'src/styles/global.css'), 'utf8')
  assert((css.match(/@source/g) ?? []).length === 1, 'the demo copy must have exactly one @source (the node_modules one)')

  // Without a lockfile npm hoists the newest Vite that @tailwindcss/vite accepts, which can be a
  // major ahead of the one this Astro version runs on (Astro 6 → Vite 7, Tailwind plugin → Vite 8).
  // Real sites pin one Vite through their lockfile; ask for the range Astro itself depends on.
  const viteRange = execFileSync('npm', ['view', `astro@${astroVersion}`, 'dependencies.vite'], { encoding: 'utf8' }).trim()
  assert(viteRange, `could not read the vite range of astro@${astroVersion}`)

  run('npm', ['pkg', 'set',
    `dependencies.@visionmediahq/astro-consent=file:${tarball}`,
    `dependencies.astro=${astroVersion}`,
    `dependencies.@astrojs/node=${adapterVersion}`,
    `dependencies.vite=${viteRange}`,
  ], dir)
  run('npm', ['install', '--no-audit', '--no-fund'], dir)

  const installed = join(dir, 'node_modules/@visionmediahq/astro-consent')
  assert(!lstatSync(installed).isSymbolicLink(), 'the package must be a real directory in node_modules, not a symlink')
  const installedAstro = JSON.parse(readFileSync(join(dir, 'node_modules/astro/package.json'), 'utf8')).version
  assert(installedAstro === astroVersion, `expected astro ${astroVersion}, got ${installedAstro}`)
  assert(!existsSync(join(dir, 'node_modules/astro/node_modules/vite')), 'astro must use the hoisted vite, not a nested copy')
  const installedVite = JSON.parse(readFileSync(join(dir, 'node_modules/vite/package.json'), 'utf8')).version
  console.log(`installed: astro@${installedAstro} vite@${installedVite}`)

  run('npx', ['astro', 'build'], dir)

  const index = readFileSync(join(dir, 'dist/client/index.html'), 'utf8')
  assert(index.includes('data-consent-banner'), 'built index.html has no data-consent-banner')
  // The widget's placeholder must be live markup, outside its inert <template>: Astro 6 leaves a
  // self-closed <template … /> open and swallows what follows, so the page shows no "Visa" button.
  const flode = readFileSync(join(dir, 'dist/client/flode/index.html'), 'utf8')
  const payloads = [...flode.matchAll(/<template data-payload[^>]*>([\s\S]*?)<\/template>/g)]
  assert(payloads.length >= 2, `flode/index.html has ${payloads.length} data-payload templates, expected the two widgets' (and the calendar's)`)
  for (const [, inner] of payloads) assert(!/data-(?:load|placeholder)/.test(inner), 'a widget placeholder is inside its <template data-payload>: the template was not closed')
  const liveLoads = flode.replace(/<template[\s\S]*?<\/template>/g, '').match(/data-load/g)?.length ?? 0
  assert(liveLoads >= 3, `flode/index.html has ${liveLoads} live "Visa" buttons, expected 3`)
  const assetDir = join(dir, 'dist/client/_astro')
  const allCss = readdirSync(assetDir).filter((file) => file.endsWith('.css')).map((file) => readFileSync(join(assetDir, file), 'utf8')).join('\n')
  assert(allCss.includes('card-actions'), 'built CSS has no card-actions — Tailwind did not scan the package in node_modules')

  await assertDevServerLoads(dir)
  console.log('✓ astro dev loads the page and its scripts without a pre-bundling error')

  assert(existsSync(join(installed, 'src')) && existsSync(join(installed, 'services.json')), 'installed package lacks src/ or services.json')
  for (const extra of ['tests', 'demo', 'ci', 'scripts']) {
    assert(!existsSync(join(installed, extra)), `installed package must not contain ${extra}/`)
  }
  const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  for (const name of FORBIDDEN_SCRIPTS) {
    assert(!(name in (installedPkg.scripts ?? {})), `package.json must not have a "${name}" script`)
  }
  assert(!('workspaces' in installedPkg), 'package.json must not have workspaces')

  // Only in this temp copy, after the demo build passed: the demo itself never has a bad page.
  const badPage = join(dir, 'src/pages/widget-script.astro')
  for (const tag of WIDGET_SLOT_SCRIPTS) {
    writeFileSync(badPage, widgetPage(tag))
    const build = spawnSync('npx', ['astro', 'build'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } })
    const output = `${build.stdout}${build.stderr}`
    if (build.status === 0 || !output.includes(SLOT_ERROR)) console.error(output)
    assert(build.status !== 0, `build with ${tag} in a ConsentWidget slot must fail, but it passed`)
    assert(output.includes(SLOT_ERROR), `build with ${tag} in a ConsentWidget slot failed without "${SLOT_ERROR}"`)
    console.log(`✓ build fails on ${tag} in a ConsentWidget slot`)
  }
  rmSync(badPage)

  // #107: an embed whose src is another site's renders a message instead of the embed, and the build
  // passes. The right embed next to it keeps a closed <template> and a live "Visa" (Astro 6, above).
  const srcPage = join(dir, 'src/pages/fel-adress.astro')
  writeFileSync(
    srcPage,
    [
      '---',
      "import ConsentEmbed from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'",
      'export const prerender = true',
      "const fromCms = 'https://example.org/karta'",
      '---',
      '<html><head><title>t</title></head><body>',
      '<ConsentEmbed id="wrong" service="google-maps" src={fromCms} title="Hitta hit" />',
      '<ConsentEmbed id="right" service="google-maps" src="https://www.google.com/maps/embed?pb=r" title="r" />',
      '</body></html>',
    ].join('\n'),
  )
  run('npx', ['astro', 'build'], dir)
  const fel = readFileSync(join(dir, 'dist/client/fel-adress/index.html'), 'utf8')
  assert(fel.includes('Hitta hit kan inte visas.'), 'fel-adress: the embed with another host\'s src does not show its message')
  assert(!fel.includes('example.org'), 'fel-adress: the other host\'s URL is in the page')
  const felPayloads = [...fel.matchAll(/<template data-payload[^>]*>([\s\S]*?)<\/template>/g)]
  assert(felPayloads.length === 1, `fel-adress has ${felPayloads.length} data-payload templates, expected the right embed's only`)
  assert((fel.replace(/<template[\s\S]*?<\/template>/g, '').match(/data-load/g)?.length ?? 0) === 1, 'fel-adress: the right embed has no live "Visa"')
  rmSync(srcPage)
  console.log('✓ an embed with another host\'s src renders a message (#107)')

  console.log(`✓ pack-install astro@${astroVersion} @astrojs/node@${adapterVersion}`)
} catch (error) {
  console.error(`✗ ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  if (tarball) rmSync(tarball, { force: true })
  if (dir) rmSync(dir, { recursive: true, force: true })
}
