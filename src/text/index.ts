import en from './en.json'
import sv from './sv.json'

import { LANGS, type Lang } from './lang'

export { LANGS, type Lang }
export type Text = typeof sv

export const TEXTS: Record<Lang, Text> = { sv, en }

/**
 * The language of the banner, placeholders and links: the `lang` prop when it
 * is given (non-empty), else the page's locale. The region subtag is dropped
 * ("en-GB" is "en"). Anything unsupported is Swedish.
 */
export function resolveLang(prop?: string | null, currentLocale?: string | null): Lang {
  const raw = prop || currentLocale || ''
  const base = raw.toLowerCase().split(/[-_]/)[0]
  return (LANGS as readonly string[]).includes(base) ? (base as Lang) : 'sv'
}
