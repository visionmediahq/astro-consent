import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type DemoMode = 'consent' | 'notice'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
export const DEMO_DIR = join(REPO_ROOT, 'demo')

/** Pages with a <ConsentEmbed>. A site with no services has no embeds, so notice mode drops them. */
export const EMBED_PAGES = ['src/pages/karta.astro', 'src/pages/ssr.astro', 'src/pages/utan-banner.astro']

const REPO_SOURCE_LINE = '@source "../../../src";'
const SKIP = new Set(['node_modules', '.astro', 'package-lock.json', 'data'])

/**
 * The one way to get a buildable demo tree for a mode: a fresh copy in the OS temp dir.
 * With `linkNodeModules` the copy shares demo/node_modules (the package is a symlink to this repo);
 * without it the caller installs its own node_modules.
 */
export function copyDemo(mode: DemoMode, opts: { linkNodeModules: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-consent-demo-'))
  cpSync(DEMO_DIR, dir, {
    recursive: true,
    filter: (source) => {
      const name = basename(source)
      return !SKIP.has(name) && !name.startsWith('dist')
    },
  })
  if (opts.linkNodeModules) symlinkSync(join(DEMO_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir')

  // From a temp copy the relative path to the repo's src points nowhere, and Tailwind scans
  // nothing for a missing source directory without saying so.
  const cssPath = join(dir, 'src/styles/global.css')
  const css = readFileSync(cssPath, 'utf8')
  if (!css.includes(REPO_SOURCE_LINE)) throw new Error(`demo-copy: ${REPO_SOURCE_LINE} not found in demo global.css`)
  const replacement = opts.linkNodeModules ? `@source "${REPO_ROOT}/src";` : ''
  writeFileSync(cssPath, css.replace(REPO_SOURCE_LINE, replacement).replace(/\n{2,}/g, '\n'))

  mkdirSync(join(dir, 'src/data'), { recursive: true })
  copyFileSync(join(DEMO_DIR, `privacy.${mode}.json`), join(dir, 'src/data/privacy.json'))
  if (mode === 'notice') for (const page of EMBED_PAGES) rmSync(join(dir, page))
  return dir
}
