// Text helpers for ConsentPolicy (#89). Node-free, so the component and unit tests share them.

/** Replaces `{key}` with `vars[key]`; a placeholder without a value stays as it is. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)
}

/** `text`, filled, split around `{token}`: the parts before and after, so the token can be a link. */
export function splitAt(text: string, token: string, vars: Record<string, string>): [string, string] {
  const [before = '', after = ''] = fill(text, vars).split(`{${token}}`)
  return [before, after]
}

/** A duration in whole months (an average month of 365.25 / 12 days). */
export function monthsOf(ms: number): number {
  return Math.round(ms / ((365.25 / 12) * 24 * 3600 * 1000))
}
