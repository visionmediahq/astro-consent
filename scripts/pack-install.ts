// Proves the package works from a real node_modules: npm pack → install the tarball into a copy of
// the demo with a given Astro version → build → assert the banner and its CSS are there.
// Usage: npm run test:pack -- <astro version> <@astrojs/node version>
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

  console.log(`✓ pack-install astro@${astroVersion} @astrojs/node@${adapterVersion}`)
} catch (error) {
  console.error(`✗ ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  if (tarball) rmSync(tarball, { force: true })
  if (dir) rmSync(dir, { recursive: true, force: true })
}
