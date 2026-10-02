import node from '@astrojs/node'
import tailwindcss from '@tailwindcss/vite'
import consent from '@visionmediahq/astro-consent'
import { defineConfig } from 'astro/config'

// Astro-6-compatible APIs only: scripts/pack-install.ts builds this same config on Astro 6.
export default defineConfig({
  site: process.env.CONSENT_DEMO_SITE ?? 'https://demo.test',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [consent()],
  outDir: process.env.CONSENT_DEMO_OUTDIR ?? './dist',
  vite: {
    plugins: [tailwindcss()],
    // The repo root and the demo each install astro; without dedupe the server bundle gets two runtimes.
    resolve: { dedupe: ['astro'] },
  },
})
