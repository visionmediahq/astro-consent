import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEMO_DIR, copyDemo, type DemoMode } from './demo-copy'

const mode = process.argv[2]
if (mode !== 'consent' && mode !== 'notice') {
  console.error('usage: npm run demo:build -- consent|notice')
  process.exit(2)
}

const dir = copyDemo(mode as DemoMode, { linkNodeModules: true })
const outDir = join(DEMO_DIR, `dist-${mode}`)
const result = spawnSync('npx', ['astro', 'build'], {
  cwd: dir,
  stdio: 'inherit',
  env: { ...process.env, CONSENT_DEMO_OUTDIR: outDir, ASTRO_TELEMETRY_DISABLED: '1' },
})
rmSync(dir, { recursive: true, force: true })
if (result.status === 0) console.log(`✓ built demo (${mode}) → ${outDir}`)
process.exit(result.status ?? 1)
