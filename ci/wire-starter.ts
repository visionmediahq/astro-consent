// Applies the edits a site needs to use @visionmediahq/astro-consent to an astro-starter checkout.
// Repo tool (CI and the starter rollout); not shipped in the installed package.
// Usage: npx tsx ci/wire-starter.ts <starter dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = '@visionmediahq/astro-consent'

function indexOfAnchor(source: string, anchor: string): number {
  const index = source.indexOf(anchor)
  if (index < 0) throw new Error(`wire-starter: anchor not found: ${anchor.trim()}`)
  return index
}

function insertAfter(source: string, anchor: string, text: string): string {
  const end = indexOfAnchor(source, anchor) + anchor.length
  return source.slice(0, end) + text + source.slice(end)
}

/** Inserts `line` on its own line above the line containing `anchor`, with the same indentation. */
function insertLineBefore(source: string, anchor: string, line: string, extraIndent = ''): string {
  const index = indexOfAnchor(source, anchor)
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  const indent = source.slice(lineStart, index).match(/^\s*/)![0]
  return source.slice(0, lineStart) + indent + extraIndent + line + '\n' + source.slice(lineStart)
}

function addFrontmatterImport(source: string, line: string): string {
  return source.includes(line) ? source : insertAfter(source, '---\n', line + '\n')
}

export function wireConfig(source: string): string {
  if (source.includes(`'${PKG}'`)) return source
  const withImport = insertAfter(source, "import tailwindcss from '@tailwindcss/vite'\n", `import consent from '${PKG}'\n`)
  return insertAfter(withImport, 'integrations: [\n', '    consent(),\n')
}

export function wireCss(source: string): string {
  const line = `@source "../../node_modules/${PKG}/src";`
  if (source.includes(line)) return source
  return source.replace(/\n*$/, '\n') + line + '\n'
}

export function wireBase(source: string): string {
  if (source.includes('<ConsentBanner')) return source
  const withImport = addFrontmatterImport(source, `import ConsentBanner from '${PKG}/components/ConsentBanner.astro'`)
  return insertLineBefore(withImport, '<VisionFooter />', '<ConsentBanner />')
}

export function wireFooter(source: string): string {
  if (source.includes('<PrivacyLinks')) return source
  const withImport = addFrontmatterImport(source, `import PrivacyLinks from '${PKG}/components/PrivacyLinks.astro'`)
  return insertLineBefore(withImport, '</footer>', '<PrivacyLinks class="mt-2 text-neutral-content" />', '  ')
}

const EDITS: Array<[string, (source: string) => string]> = [
  ['astro.config.ts', wireConfig],
  ['src/styles/global.css', wireCss],
  ['src/layouts/Base.astro', wireBase],
  ['src/components/VisionFooter.astro', wireFooter],
]

function main(dir: string): void {
  for (const [file, wire] of EDITS) {
    const path = join(dir, file)
    const before = readFileSync(path, 'utf8')
    const after = wire(before)
    if (after === before) {
      console.log(`✓ already wired ${file}`)
    } else {
      writeFileSync(path, after)
      console.log(`✓ wired ${file}`)
    }
  }
  const privacy = join(dir, 'src/data/privacy.json')
  if (existsSync(privacy)) {
    console.log('✓ already present src/data/privacy.json')
  } else {
    mkdirSync(join(dir, 'src/data'), { recursive: true })
    writeFileSync(privacy, '{ "services": [] }\n')
    console.log('✓ created src/data/privacy.json')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: tsx ci/wire-starter.ts <starter dir>')
    process.exit(2)
  }
  main(dir)
}
