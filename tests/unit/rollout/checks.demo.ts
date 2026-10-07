// Browser smoke for ci/rollout/checks on the consent demo. A script, not a vitest file.
//   npm run demo:build -- consent
//   npx tsx tests/unit/rollout/checks.demo.ts
// Every registry and log-host request is stubbed (stub: true): nothing reaches Google.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { checkClip } from '../../../ci/rollout/checks/clip'
import { checkConsentPaths } from '../../../ci/rollout/checks/consent-paths'
import { checkContrast } from '../../../ci/rollout/checks/contrast'
import { listPages } from '../../../ci/rollout/checks/pages'
import { checkRequests, formatRequests } from '../../../ci/rollout/checks/requests'
import { shots } from '../../../ci/rollout/checks/shots'

const ROOT = join(import.meta.dirname, '../../..')
const BASE = 'http://127.0.0.1:4321'

const server = spawn('node', ['demo/dist-consent/server/entry.mjs'], {
  cwd: ROOT,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '4321' },
  stdio: 'ignore',
})

async function up(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/')).ok) return
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('demo server did not start')
}

const out = mkdtempSync(join(tmpdir(), 'checks-shots-'))
const browser = await chromium.launch()
let failed = false
const fail = (cond: boolean, what: string) => {
  if (!cond) {
    failed = true
    console.log(`  FAIL ${what}`)
  }
}
try {
  await up()

  console.log('listPages (static, demo/dist-consent/client):')
  console.log(' ', (await listPages(BASE, { distDir: join(ROOT, 'demo/dist-consent/client'), ssr: false })).join(' '))
  console.log('listPages (ssr crawl):')
  console.log(' ', (await listPages(BASE, { ssr: true })).join(' '))

  console.log('checkRequests:')
  const requests = await checkRequests(browser, BASE, ['/', '/karta'], { stub: true })
  for (const line of formatRequests(requests)) console.log(' ', line)
  for (const r of requests) fail(r.banner && r.blocked.length === 0, `${r.path} banner/blocked`)

  console.log('checkConsentPaths:')
  for (const r of await checkConsentPaths(browser, BASE, ['/karta'])) {
    console.log(' ', JSON.stringify(r))
    fail(r.visaLoadsOnlyClicked && r.rememberAutoShows && r.nekaLoadsNothing && r.filterKept, `${r.path} consent paths`)
  }

  console.log('checkClip:')
  const clip = await checkClip(browser, BASE, ['/karta'])
  for (const r of clip) console.log(`  ${r.path} ${r.width}px "${r.button}" ${r.w}px in ${r.boxW}px ${r.clipped ? 'CLIPPED' : 'ok'}`)
  fail(clip.length > 0 && clip.every((r) => !r.clipped), 'clipping')

  console.log('checkContrast:')
  const contrast = await checkContrast(browser, BASE, ['/', '/karta'])
  for (const r of contrast) {
    console.log(`  ${r.path} ${r.kind} "${r.button}" ${r.ratio.toFixed(2)}${r.indeterminate ? ` (indeterminate: ${r.indeterminate})` : ''}`)
  }
  fail(contrast.some((r) => r.kind === 'banner') && contrast.some((r) => r.kind === 'links'), 'contrast rows of both kinds')
  fail(contrast.every((r) => r.ratio >= 4.5 && !r.indeterminate), 'contrast ≥ 4.5')

  console.log('shots:')
  const files = await shots(browser, BASE, ['/karta'], out)
  console.log(`  ${files.length} files: ${files.map((f) => f.slice(out.length + 1)).join(' ')}`)
  fail(files.length > 0, 'shots')
} finally {
  await browser.close()
  server.kill()
  rmSync(out, { recursive: true, force: true })
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
