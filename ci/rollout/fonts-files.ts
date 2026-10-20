// Self-hosts Google Fonts for a site that is generated, not rolled out (site-factory#175): fetch
// Google's own woff2 files for a css2 URL and write them, their licences and src/styles/fonts.css,
// the same files `wire` and `fonts` write for a live site. No detect, no git, no markup edits; with
// --entry it also adds `@import "./fonts.css";` after `@import "tailwindcss"` in that stylesheet.
//
//   tsx ci/rollout/fonts-files.ts <site dir> --url <css/css2 url> [--entry <css file>] [--dry-run]
//   tsx ci/rollout/run.ts fonts-files <site dir> ...                (the same command)
//
// Exit codes: 0 ok, 1 error, 2 usage, 3 refused (nothing written). Imports node built-ins and
// relative files without packages only, so it runs with tsx alone (the unit test pins this).
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { diskSite } from './lib/site-files'
import { applyEdits } from './wire/engine'
import { FONTS_CSS, FONTS_DIR, type FontFetch, importEdit, selfHostFonts } from './wire/fonts-host'

const USAGE = 'usage: tsx ci/rollout/fonts-files.ts <site dir> --url <css/css2 url> [--entry <css file>] [--dry-run]'

export interface FontsFilesArgs {
  dir: string
  url: string
  /** The Tailwind stylesheet (site-relative) to add the fonts.css import to; null leaves it alone. */
  entry: string | null
  dryRun: boolean
}

export function parseFontsFilesArgs(args: string[]): FontsFilesArgs {
  let dir: string | null = null
  let url: string | null = null
  let entry: string | null = null
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const option = (name: string): string | null => {
      if (arg === name) {
        const value = args[++i]
        if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value\n${USAGE}`)
        return value
      }
      return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null
    }
    const u = option('--url')
    const e = option('--entry')
    if (u !== null) url = u
    else if (e !== null) entry = e
    else if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${USAGE}`)
    else if (dir === null) dir = arg
    else throw new Error(`one site dir only\n${USAGE}`)
  }
  if (dir === null) throw new Error(USAGE)
  if (url === null) throw new Error(`--url is required\n${USAGE}`)
  return { dir, url, entry, dryRun }
}

export interface FontsFilesOptions {
  /** The network; the real one unless a test injects recordings. */
  fetch?: FontFetch
  /** The date in the fonts.css header. */
  now?: Date
}

/** Runs the command. Throws on an unusable site dir; refusals are code 3 and write nothing. */
export async function runFontsFiles(args: FontsFilesArgs, opts: FontsFilesOptions = {}): Promise<{ code: number; output: string }> {
  const root = resolve(args.dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${args.dir} is not a directory`)
  const refuse = (reason: string) => ({ code: 3, output: `fonts-files: refused, nothing written: ${reason}\n` })
  const files = diskSite(root)
  // css (v1) as well as css2: Scout records whichever <link> the client's old site had, and
  // Google answers both with the same @font-face blocks.
  if (!/^https:\/\/fonts\.googleapis\.com\/css2?\?/.test(args.url)) return refuse(`not a Google Fonts css/css2 URL: ${args.url}`)
  if (files.exists(FONTS_CSS)) return refuse(`${FONTS_CSS} already exists`)
  if (files.list(`${FONTS_DIR}/**`).length > 0) return refuse(`${FONTS_DIR}/ already exists`)

  // The import first: it needs no network, so a stylesheet we cannot edit refuses before any request.
  let entryText: string | null = null
  if (args.entry !== null) {
    if (isAbsolute(args.entry) || args.entry.split('/').includes('..')) return refuse(`--entry must be a path inside the site: ${args.entry}`)
    try {
      entryText = applyEdits(files.read(args.entry), [importEdit(files, args.entry)])
    } catch (e) {
      return refuse((e as Error).message)
    }
  }

  let hosted: Awaited<ReturnType<typeof selfHostFonts>>
  try {
    hosted = await selfHostFonts(files, args.url, opts)
  } catch (e) {
    return refuse((e as Error).message)
  }

  const out: { path: string; data: string | Uint8Array }[] = [
    ...hosted.newFiles.map((f) => ({ path: f.path, data: f.text })),
    ...hosted.fontFiles.map((f) => ({ path: f.path, data: f.bytes })),
  ]
  if (args.entry !== null && entryText !== null) out.push({ path: args.entry, data: entryText })
  if (!args.dryRun) {
    for (const f of out) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true })
      writeFileSync(join(root, f.path), f.data)
    }
  }
  const lines = [
    `fonts-files: ${args.dryRun ? 'dry run, would write' : 'wrote'} ${out.length} files for ${args.url}`,
    ...hosted.notes,
    ...out.map((f) => `  ${f.path === args.entry ? 'edit' : 'new '} ${f.path}`),
  ]
  return { code: 0, output: `${lines.join('\n')}\n` }
}

export async function main(argv: string[], opts: FontsFilesOptions = {}): Promise<number> {
  let args: FontsFilesArgs
  try {
    args = parseFontsFilesArgs(argv)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const { code, output } = await runFontsFiles(args, opts)
    if (code === 0) process.stdout.write(output)
    else process.stderr.write(output)
    return code
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
