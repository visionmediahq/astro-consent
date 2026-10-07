// The wire engine: each part of the wiring (config, CSS, layout, links, …) registers targets with a
// Planner. A target is located in the parse tree of its file and must be found exactly once; its
// edit is a text splice at that offset, so the site's own formatting and comments stay as they are.
// Nothing is written here: result() is the whole plan, or the refusals if any target failed.
import type { Edit, Refusal, WirePlan } from '../types'
import type { SiteFiles } from '../lib/site-files'

export interface Hit {
  start: number
  end: number
}

export type EditMode = 'insert-before' | 'insert-after' | 'replace'

/** The line ending a file uses: CRLF when it has any, LF otherwise. */
export function eolOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Ascending by start; at one offset, inserts before a replace, and otherwise in plan order. */
function ordered<T extends { start: number; end: number }>(edits: readonly T[]): T[] {
  return edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.start - b.e.start || (a.e.end - a.e.start === 0 ? 0 : 1) - (b.e.end - b.e.start === 0 ? 0 : 1) || a.i - b.i)
    .map(({ e }) => e)
}

function assertNoOverlap(edits: readonly { start: number; end: number; target?: string }[], file: string): void {
  const sorted = ordered(edits)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (prev.end > cur.start) {
      throw new Error(
        `overlapping edits in ${file}: [${prev.start}, ${prev.end})${prev.target ? ` (${prev.target})` : ''} and [${cur.start}, ${cur.end})${cur.target ? ` (${cur.target})` : ''}`,
      )
    }
  }
}

/**
 * Applies `edits` (all for one file, offsets into `text`) from the highest offset down, so each
 * offset refers to the original text. Bytes outside the edits are untouched. Inserts at one offset
 * come out in the order given. Overlapping edits are a programming error and throw.
 */
export function applyEdits(text: string, edits: readonly Pick<Edit, 'start' | 'end' | 'text'>[]): string {
  for (const e of edits) {
    if (e.start < 0 || e.end < e.start || e.end > text.length) throw new Error(`edit [${e.start}, ${e.end}) is outside the text (${text.length})`)
  }
  assertNoOverlap(edits, 'text')
  let out = text
  for (const e of ordered(edits).reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

export class Planner {
  readonly files: SiteFiles
  private readonly edits: Edit[] = []
  private readonly newFiles: { path: string; text: string }[] = []
  private readonly skipped: string[] = []
  private readonly refusals: Refusal[] = []

  constructor(files: SiteFiles) {
    this.files = files
  }

  /**
   * Plans one edit. Skipped when `alreadyWired()`; otherwise `locate()` must return exactly one hit
   * in `file`, or the target is refused ("found N"). The edit puts `text(hit)` before the hit, after
   * it, or in its place. A `locate` that throws (a missing file, a parse error) is a refusal too.
   */
  target(
    name: string,
    file: string,
    alreadyWired: () => boolean,
    locate: () => Hit[],
    text: (hit: Hit) => string,
    mode: EditMode,
  ): void {
    let hits: Hit[]
    try {
      if (alreadyWired()) {
        this.skipped.push(name)
        return
      }
      hits = locate()
    } catch (e) {
      this.refuse(file, name, e instanceof Error ? e.message : String(e))
      return
    }
    if (hits.length !== 1) {
      this.refuse(file, name, `found ${hits.length}, expected exactly 1`)
      return
    }
    const hit = hits[0]!
    const at = mode === 'insert-after' ? hit.end : hit.start
    this.edits.push({ file, start: at, end: mode === 'replace' ? hit.end : at, text: text(hit), target: name })
  }

  /** Plans a new file; skipped when the file already exists. */
  newFile(name: string, path: string, text: string): void {
    if (this.files.exists(path)) this.skipped.push(name)
    else this.newFiles.push({ path, text })
  }

  /** Refuses a target that cannot be planned at all (an unusual shape, a missing input). */
  refuse(file: string, target: string, reason: string): void {
    this.refusals.push({ file, target, reason })
  }

  /** The plan: every edit, or (if any target was refused) only the refusals. */
  result(): WirePlan {
    if (this.refusals.length > 0) return { ok: false, refusals: [...this.refusals] }
    const byFile = new Map<string, Edit[]>()
    for (const e of this.edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e])
    for (const [file, edits] of byFile) assertNoOverlap(edits, file)
    return { ok: true, edits: [...this.edits], newFiles: [...this.newFiles], skipped: [...this.skipped] }
  }
}
