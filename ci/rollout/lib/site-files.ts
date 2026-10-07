import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Read-only view of a site's files, by site-relative POSIX paths. */
export interface SiteFiles {
  root: string
  /** Site-relative paths matching `glob` (`*`, `**`, `?`, `{a,b}`), sorted. */
  list(glob: string): string[]
  read(path: string): string
  exists(path: string): boolean
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro'])

function walk(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full)
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  visit(root)
  return out.sort()
}

export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') re += '[^/]'
    else if (c === '{') re += '(?:'
    else if (c === '}') re += ')'
    else if (c === ',') re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function makeSite(root: string, suffix: string): SiteFiles {
  const onDisk = (path: string): string => join(root, path + suffix)
  return {
    root,
    list(glob) {
      const re = globToRegExp(glob)
      return walk(root)
        .filter((p) => p.endsWith(suffix))
        .map((p) => p.slice(0, p.length - suffix.length))
        .filter((p) => re.test(p))
    },
    read: (path) => readFileSync(onDisk(path), 'utf8'),
    exists: (path) => existsSync(onDisk(path)) && statSync(onDisk(path)).isFile(),
  }
}

/** A site checkout on disk. */
export function diskSite(dir: string): SiteFiles {
  return makeSite(dir, '')
}

/** A test fixture: every file is stored with a `.txt` suffix, which the paths leave out. */
export function fixtureSite(dir: string): SiteFiles {
  return makeSite(dir, '.txt')
}
