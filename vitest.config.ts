import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 20 s: the rollout tests that clone, branch and commit in temp git repos (wire, fonts, update,
  // lockfile) ran past the 5 s default under full-suite load on a busy machine.
  test: { environment: 'node', testTimeout: 20_000 },
})
