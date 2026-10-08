import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

test('a release tag cannot go green while the starter-install proof is switched off', () => {
  expect(workflow).toMatch(/^  release-guard:/m)
  const guard = workflow.slice(workflow.indexOf('  release-guard:'))
  expect(guard).toMatch(/if: startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.STARTER_INSTALL != 'true'/)
  expect(guard).toMatch(/exit 1/)
})

test('starter-install is gated by a repo variable, not by the secrets context', () => {
  const job = workflow.slice(workflow.indexOf('  starter-install:'), workflow.indexOf('  release-guard:'))
  expect(job).toMatch(/if: .*vars\.STARTER_INSTALL == 'true'/)
  expect(job).not.toMatch(/if: .*secrets\./)
})

test('CI runs the rollout browser checks on the built demo, right after the consent demo build', () => {
  const job = workflow.slice(workflow.indexOf('  e2e:'), workflow.indexOf('  pack-install:'))
  const steps = job.split('\n').filter((l) => l.trimStart().startsWith('- run:')).map((l) => l.trim())
  const build = steps.indexOf('- run: npm run demo:build -- consent')
  expect(build).toBeGreaterThan(steps.indexOf('- run: npx playwright install --with-deps chromium'))
  expect(steps[build + 1]).toBe('- run: npx tsx ci/rollout/run.ts verify --demo demo/dist-consent')
})
