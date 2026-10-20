// Whether a module is the script node was started with. import.meta.url is a real path; argv[1] is
// whatever was typed, possibly through a symlink (macOS /var -> /private/var, a symlinked checkout),
// so both are resolved first. Imports node built-ins only (fonts-files.ts must stay standalone).
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const real = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

export function isEntryScript(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false
  if (metaUrl === pathToFileURL(argv1).href) return true
  const mine = real(fileURLToPath(metaUrl))
  const theirs = real(argv1)
  return mine !== null && theirs !== null && mine === theirs
}
