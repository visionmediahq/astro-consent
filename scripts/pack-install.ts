// Proves the package works from a real node_modules: npm pack → install the tarball into a copy of
// the demo with a given Astro version → build → assert the banner and its CSS are there → build
// once more per form of <script> in a <ConsentWidget> slot and assert that build fails (#27).
// Usage: npm run test:pack -- <astro version> <@astrojs/node version>
import { execFileSync, spawnSync } from 'node:child_process'
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

  console.log(`✓ pack-install astro@${astroVersion} @astrojs/node@${adapterVersion}`)
} catch (error) {
  console.error(`✗ ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  if (tarball) rmSync(tarball, { force: true })
  if (dir) rmSync(dir, { recursive: true, force: true })
}
