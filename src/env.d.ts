declare module 'virtual:astro-consent/config' {
  const config: import('./types').ConsentConfig
  export default config
}

interface Window {
  __vmConsent?: import('./client').Runtime
  umami?: { track(name: string, data?: Record<string, unknown>): void }
}
