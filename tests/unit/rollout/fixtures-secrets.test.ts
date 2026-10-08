import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'
import { scanSecrets } from '../../../ci/rollout/scan-secrets'

const FIXTURES = join(import.meta.dirname, 'fixtures')

// The repo is public: fixtures copied from client sites must never carry a credential.
test('no fixture file matches the secret scan', () => {
  const files = readdirSync(FIXTURES, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
  expect(files.length).toBeGreaterThan(0)
  const hits = files.flatMap((file) =>
    scanSecrets(readFileSync(file, 'utf8')).map((h) => `${relative(FIXTURES, file)}:${h.line}: ${h.match.slice(0, 8)}…`),
  )
  expect(hits).toEqual([])
})
