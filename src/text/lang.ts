// Node-free and JSON-free: the browser runtime's type graph imports this, never index.ts.
export const LANGS = ['sv', 'en'] as const
export type Lang = (typeof LANGS)[number]
