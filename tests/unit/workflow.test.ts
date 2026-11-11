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

const job = (name: string, next: string): string => workflow.slice(workflow.indexOf(`  ${name}:`), workflow.indexOf(`  ${next}:`))

test('CI runs the rollout browser checks on the built demo, right after the consent demo build', () => {
  const steps = job('rollout', 'pack-install').split('\n').filter((l) => l.trimStart().startsWith('- run:')).map((l) => l.trim())
  const build = steps.indexOf('- run: npm run demo:build -- consent')
  expect(build).toBeGreaterThan(steps.indexOf('- run: npx playwright install --with-deps chromium'))
  expect(steps[build + 1]).toBe('- run: npx tsx ci/rollout/run.ts verify --demo demo/dist-consent')
})

test('CI runs the fonts check fixtures (verify step 8) in the rollout job, after Chromium is installed', () => {
  const rollout = job('rollout', 'pack-install')
  expect(rollout.indexOf('run: npx tsx tests/unit/rollout/fonts-fixtures.demo.ts')).toBeGreaterThan(rollout.indexOf('npx playwright install --with-deps chromium'))
})

test('the rollout checks run on main, tags and manual runs, not on pull requests', () => {
  expect(job('rollout', 'pack-install')).toMatch(/^    if: github\.event_name != 'pull_request'$/m)
  expect(job('e2e', 'rollout')).not.toMatch(/ci\/rollout|tests\/unit\/rollout/)
})

test('push runs CI on main and release tags only; feature branches run through their PR', () => {
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'))
  expect(on).toMatch(/^  push:\n(?:    #.*\n)*    branches: \[main\]\n    tags: \['v\*'\]/m)
  expect(on).toMatch(/^  pull_request:/m)
  expect(on).toMatch(/^  workflow_dispatch:/m)
})

test('a new push cancels an older PR run, never a run on main or a tag', () => {
  const concurrency = workflow.slice(workflow.indexOf('\nconcurrency:'), workflow.indexOf('\njobs:'))
  expect(concurrency).toMatch(/group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/)
  expect(concurrency).toMatch(/cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' && !startsWith\(github\.ref, 'refs\/tags\/'\) \}\}/)
})
