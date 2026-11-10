declare module 'virtual:astro-consent/config' {
  const config: import('./types').ConsentConfig
  export default config
}

declare module 'virtual:astro-consent/policy' {
  const policy: import('./types').PolicyConfig
  export default policy
}

interface Window {
  __vmConsent?: import('./client').Runtime
  umami?: { track(name: string, data?: Record<string, unknown>): void }
}
