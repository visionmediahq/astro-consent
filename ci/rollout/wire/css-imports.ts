// The CSS reader both the banner wiring (css.ts) and the fonts import (fonts-host.ts) use. No imports:
// the Builder runs the fonts command with node and tsx alone.
/**
 * The end offsets of top-level `@import`/`@plugin` statements: after the `;`, or after the `}`
 * that closes a block such as `@plugin "daisyui/theme" { … }`. Comments, strings and unquoted
 * `url(…)` are skipped, a `;` inside parentheses does not end a statement,
 * and anything inside a block is not top level. A reader, not a CSS parser.
 */
export function topLevelImportEnds(css: string): number[] {
  const ends: number[] = []
  let depth = 0
  let parens = 0
  /** Depth-0 at-rule in progress (import/plugin or another), and whether it counts. */
  let current: { counts: boolean } | null = null
  let i = 0
  while (i < css.length) {
    const c = css[i]!
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2)
      i = close === -1 ? css.length : close + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1
      i = j + 1
      continue
    }
    // An unquoted url(…) may hold anything but `)`, `;` and quotes included: skip it whole.
    if ((c === 'u' || c === 'U') && /^url\(\s*[^\s"')]/i.test(css.slice(i, i + 6)) && !/[\w-]/.test(css[i - 1] ?? '')) {
      const close = css.indexOf(')', i)
      i = close === -1 ? css.length : close + 1
      continue
    }
    if (c === '(') parens++
    else if (c === ')') parens = Math.max(0, parens - 1)
    else if (c === '{') depth++
    else if (c === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0 && current) {
        if (current.counts) ends.push(i + 1)
        current = null
      }
    } else if (c === ';' && depth === 0 && parens === 0) {
      if (current?.counts) ends.push(i + 1)
      current = null
    } else if (depth === 0 && !current && /\S/.test(c)) {
      // The start of a top-level statement or rule.
      current = { counts: /^@(?:import|plugin)\b/i.test(css.slice(i, i + 8)) }
    }
    i++
  }
  return ends
}
