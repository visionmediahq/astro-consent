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
