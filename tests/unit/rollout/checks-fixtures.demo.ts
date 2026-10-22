// Negative controls for ci/rollout/checks: small broken pages that a check must NOT pass.
// A script, not a vitest file:   npx tsx tests/unit/rollout/checks-fixtures.demo.ts
// The pages are written to a temp dir and served on 127.0.0.1. Every registry URL in them is
// either never requested or fulfilled by the stub (stub: true): nothing reaches Google or Meta.
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { checkClip } from '../../../ci/rollout/checks/clip'
import { checkConsentPaths } from '../../../ci/rollout/checks/consent-paths'
import { checkContrast } from '../../../ci/rollout/checks/contrast'
import { checkEmbedBoxes, compareEmbedHeights } from '../../../ci/rollout/checks/embed-size'
import { checkRequests } from '../../../ci/rollout/checks/requests'
import { wcagContrast } from '../../../ci/rollout/lib/colour'

const MAPS = 'https://www.google.com/maps/embed?pb=fixture'
const CAL = 'https://calendar.google.com/calendar/embed?src=fixture'
const ELFSIGHT = 'https://elfsightcdn.com/platform.js'
const GTAG = 'https://www.googletagmanager.com/gtag/js?id=G-FIXTURE'
const PIXEL = 'https://connect.facebook.net/en_US/fbevents.js'

const banner = (style = 'position:fixed;bottom:0;left:0;right:0;background:#fff;padding:8px') =>
  `<section data-consent-banner style="${style}"><button data-consent-action="none">Neka</button><button data-consent-action="all">Acceptera alla</button></section>`
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0">${body}</body></html>`

// A fake client for the consent-path fixtures: Neka hides the banner; data-load runs `onLoad`.
const embedPage = (onLoad: string, onStart = '') =>
  page(`${banner()}
  <div data-consent-embed="google-maps" id="a"><button data-load>Visa</button><input type="checkbox" data-remember><a data-open href="${MAPS}">Öppna</a></div>
  <div data-consent-embed="google-maps" id="b"><button data-load>Visa</button><input type="checkbox" data-remember><a data-open href="${MAPS}">Öppna</a></div>
  <script>
    const add = (el) => { const f = document.createElement('iframe'); f.src = '${MAPS}'; el.appendChild(f); el.setAttribute('data-active', '') }
    document.querySelector('[data-consent-action=none]').onclick = () => { document.querySelector('[data-consent-banner]').hidden = true }
    ${onStart}
    for (const b of document.querySelectorAll('[data-load]')) b.onclick = (e) => { const el = e.target.closest('[data-consent-embed]'); ${onLoad} }
  </script>`)

// A fake client for mixed services: iframe embeds and a script widget (no iframe, no open link).
// "Visa alltid" stores the service; on start every embed of a stored service activates.
// `greedy` activates every embed instead: remembering one service must not grant the others.
const mixed = (embedsHtml: string, greedy = false) =>
  page(`${banner()}${embedsHtml}
  <script>
    const src = { 'google-maps': '${MAPS}', 'google-calendar': '${CAL}' }
    const add = (el) => {
      const s = el.dataset.consentEmbed
      if (s === 'elfsight') { const sc = document.createElement('script'); sc.src = '${ELFSIGHT}'; document.head.appendChild(sc) }
      else { const f = document.createElement('iframe'); f.src = src[s]; el.appendChild(f) }
      el.setAttribute('data-active', '')
    }
    document.querySelector('[data-consent-action=none]').onclick = () => { document.querySelector('[data-consent-banner]').hidden = true }
    const kept = JSON.parse(localStorage.getItem('kept') || '[]')
    if (kept.length) { document.querySelector('[data-consent-banner]').hidden = true; for (const el of document.querySelectorAll('[data-consent-embed]')) if (${greedy ? 'true' : 'kept.includes(el.dataset.consentEmbed)'}) add(el) }
    for (const b of document.querySelectorAll('[data-load]')) b.onclick = (e) => {
      const el = e.target.closest('[data-consent-embed]')
      if (el.querySelector('[data-remember]').checked) localStorage.setItem('kept', JSON.stringify([...kept, el.dataset.consentEmbed]))
      add(el)
    }
  </script>`)
const iframeEmbed = (service: string, href: string) =>
  `<div data-consent-embed="${service}"><button data-load>Visa</button><input type="checkbox" data-remember><a data-open href="${href}">Öppna</a></div>`
const cutPlaceholder = (box: string) =>
  `<div class="${box}"><div data-consent-embed="google-maps"><p style="height:320px;margin:0">Google Maps</p><button data-load>Visa</button><input type="checkbox" data-remember><a data-open href="${MAPS}">Öppna</a></div></div>`
// An unloaded ConsentEmbed's placeholder as the package renders it (EmbedPlaceholder.astro); its
// open link inherits the text colour, as daisyUI's .link does.
const placeholder = (style: string) =>
  `<div data-consent-embed="google-maps" style="${style}"><div data-placeholder><div><p>Kartan hämtas från Google Maps.</p></div><div><button data-load>Visa</button><label><input type="checkbox" data-remember> Visa alltid</label><a data-open href="${MAPS}" style="color:inherit">Öppna</a></div></div></div>`
// knutssonsbil's shape: a box whose height is padding (40 % of the width) plus a min-height (here
// content-box, so 40 % + 320px; the shape, not knutssonsbil's numbers, is what matters).
const ratioBox = (inner: string) => `<div style="position:relative;padding-bottom:40%;min-height:320px">${inner}</div>`
const gradientFooter = (background: string, footer = '', links = 'color:rgb(255 255 255 / 0.7)') =>
  `<style>:root{--color-primary:#004b85;--brand-dark:#00375f}footer{background:${background};color:#fff;padding:24px;${footer}}</style><footer><div data-privacy-links style="${links}"><button data-consent-open style="color:inherit;background:none;border:0">Cookie-inställningar</button> <a href="/integritet" style="color:inherit">Integritetspolicy</a></div></footer>`
const whiteLink = `<div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div>`
const PF = 'footer{position:relative;background:#000;padding:24px}'
const ANC = 'footer{position:relative;background:#000;padding:400px 24px 24px}footer::before{content:"";position:absolute;left:0;right:0;top:800px;height:100px;background:#fff}'
const svgUrl = (s: string) => `url("data:image/svg+xml,${encodeURIComponent(s).replace(/'/g, '%27')}")`
const NOISE_FILTERED = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`)
const NOISE_WHITE_RECT = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence baseFrequency='0.8'/></filter><rect width='100%' height='100%' fill='white'/></svg>`)
const BLACK_GRAIN = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence baseFrequency='0.8'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`)
const fixedStrip = (decl: string) =>
  `<style>footer{background:#000;padding:24px}.w{${decl};margin-left:400px}.w::before{content:"";position:fixed;left:0;top:0;width:300px;height:100%;background:#fff}</style><footer><div class="w">${whiteLink}</div></footer>`
const widget = `<div data-consent-embed="elfsight" data-script="${ELFSIGHT}"><template data-payload><div class="elfsight-app-x"></div></template><button data-load>Visa</button><input type="checkbox" data-remember></div>`

const LATE = `${banner()}<div style="height:10000px;position:relative"><div id="s" style="position:absolute;top:3000px;height:10px"></div></div>
    <script>new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { o.disconnect(); const s = document.createElement('script'); s.src = '${GTAG}'; document.head.appendChild(s) } }).observe(document.getElementById('s'))</script>`

const FIXTURES: Record<string, string> = {
  // Banner controls and look-alikes.
  ok: page(banner()),
  transparent: page(banner('position:fixed;bottom:0;left:0;right:0;opacity:0')),
  covered: page(`${banner()}<div style="position:fixed;inset:0;z-index:10;background:#fff"></div>`),
  offscreen: page(banner('position:fixed;top:-500px;left:0;right:0;background:#fff')),
  two: page(banner() + banner()),
  // Item 1: a lazy embed that is in the DOM but never requested, and one that loads only mid-page.
  lazy: page(`${banner()}<iframe data-src="${MAPS}"></iframe>`),
  late: page(LATE),
  // The same with smooth scrolling (a fleet site's global.css sets it): scrollBy animates.
  smooth: page(`<style>html { scroll-behavior: smooth }</style>${LATE}`),
  // Item 4: "Visa" that is not one-off, and "Visa" that loads another service too.
  sticky: embedPage(`add(el); localStorage.setItem('sticky', '1')`, `if (localStorage.getItem('sticky')) document.querySelectorAll('[data-consent-embed]').forEach(add)`),
  other: embedPage(`add(el); const s = document.createElement('script'); s.src = '${PIXEL}'; document.head.appendChild(s)`),
  oneoff: embedPage(`add(el)`),
  // A loaded map keeps fetching tiles until the page goes away (knutssonsbil#2 live: tile and RPC
  // requests from the old map fired as the reload started and were counted as "after reload").
  // Visa that leaves no embed behind but makes the reloaded page request the registry anyway.
  ghost: embedPage(`add(el); localStorage.setItem('ghost', '1')`, `if (localStorage.getItem('ghost')) new Image().src = '${MAPS}&ghost'`),
  busy: embedPage(`add(el); let i = 0; setInterval(() => { new Image().src = '${MAPS}&tile=' + i++ }, 50)`),
  // Visa that loads an iframe the page then squashes to nothing (salviablommor: a scoped display:block
  // on the wrapper beat `grid`, so the loaded map was 0px tall).
  flat: embedPage(`add(el); el.querySelector('iframe').style.height = '0'`),
  // The real mechanism: ConsentEmbed's iframe is absolute inset-0, so once the placeholder is gone an
  // embed whose wrapper does not stretch it (display:block, aspect auto) has no height at all.
  collapsed: embedPage(`add(el); el.style.position = 'relative'; el.querySelector('iframe').style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0'; for (const c of [...el.children]) if (c.tagName !== 'IFRAME') c.hidden = true`),
  // Mixed services (maps, calendar, an Elfsight widget): Visa on a widget first, and Visa alltid
  // carrying one service over to a page that also has others.
  widget: mixed(widget + iframeEmbed('google-maps', MAPS)),
  mixa: mixed(iframeEmbed('google-maps', MAPS) + iframeEmbed('google-calendar', CAL) + widget),
  mixb: mixed(iframeEmbed('google-calendar', CAL) + widget + iframeEmbed('google-maps', MAPS) + iframeEmbed('google-maps', MAPS)),
  greedya: mixed(iframeEmbed('google-maps', MAPS) + iframeEmbed('google-calendar', CAL), true),
  greedyb: mixed(iframeEmbed('google-calendar', CAL) + iframeEmbed('google-maps', MAPS), true),
  // #46: light text on the light placeholder (a dark theme without base-200), and a readable control.
  darkph: page(placeholder('background:#f8f8f8;color:#daeaf5')),
  okph: page(placeholder('background:#f8f8f8;color:#1f2937')),
  // nanolfs-villan: a footer whose background is a gradient of two brand blues through var(), and
  // PrivacyLinks in white/70. A gradient ending near white fails; a photo over the gradient is unknown.
  gradfoot: page(gradientFooter('linear-gradient(180deg, var(--color-primary) 0%, var(--brand-dark) 100%)')),
  gradfail: page(gradientFooter('linear-gradient(180deg, var(--brand-dark) 0%, #fafafa 100%)')),
  gradphoto: page(gradientFooter('url("/photo.jpg"), linear-gradient(180deg, var(--color-primary) 0%, var(--brand-dark) 100%)')),
  // PR #72 review: white on darkblue→darkred in hsl longer hue passes yellow (3.64:1), not the 10:1
  // of its stops; a dark gradient screened over white; a black gradient clipped to the text.
  gradhsl: page(gradientFooter('linear-gradient(to right in hsl longer hue, darkblue, darkred)', '', 'color:#fff')),
  gradblend: page(gradientFooter('linear-gradient(#003, #003), #fff', 'background-blend-mode:screen', 'color:#fff')),
  gradclip: page(gradientFooter('linear-gradient(#000, #000)', '-webkit-background-clip:text;background-clip:text', 'color:#fff')),
  // Ancestor effects: a filter on the footer; opacity on a footer with a background (indeterminate),
  // and opacity on the background-less links wrapper (folded into the text colour, measured).
  gradfilter: page(gradientFooter('#00375f', 'filter:brightness(3)', 'color:#fff')),
  gradfade: page(gradientFooter('#00375f', 'opacity:0.4', 'color:#fff')),
  linksfade: page(gradientFooter('#00375f', '', 'color:#fff;opacity:0.7')),
  // PR #72 re-review. The starter's [data-animate]: opacity 0 in CSS, faded in by Motion's inView
  // when scrolled to. Below the fold: a placeholder inside one (ernstedt, knutssonsbil, …), and a
  // background-less one around PrivacyLinks; a slow 2.5 s fade, and an infinite spinner elsewhere
  // that must not hold the wait up.
  animated: page(`<style>[data-animate]{opacity:0}@keyframes spin{to{transform:rotate(360deg)}}</style>
    <div style="width:20px;height:20px;background:#ccc;animation:spin 1s linear infinite"></div>
    <div style="height:2000px"></div>
    <div data-animate>${placeholder('background:#f8f8f8;color:#1f2937')}</div>
    <div style="height:1500px"></div>
    <footer style="background:#00375f;padding:24px"><div data-animate data-slow><div data-privacy-links style="color:#fff"><button data-consent-open style="color:inherit;background:none;border:0">Cookie-inställningar</button></div></div></footer>
    <script>
      for (const el of document.querySelectorAll('[data-animate]'))
        new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { o.disconnect(); el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 'slow' in el.dataset ? 2500 : 500, fill: 'forwards' }) } }).observe(el)
    </script>`),
  // ahatrafikskola: a 1px absolute gradient hairline at the top of the footer, and an a::after
  // underline at width 0: neither is over the text.
  hairline: page(`<style>footer{position:relative;background:#00375f;padding:24px}footer::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,#f00,#00f)}a{position:relative;color:#fff}a::after{content:'';position:absolute;left:0;bottom:-2px;width:0;height:2px;background:#fff}</style><footer><div data-privacy-links><a href="/integritet">Integritetspolicy</a></div></footer>`),
  // A white ::before at z-index -1 inside an isolated black footer paints over the black, under the
  // white text; a near-white overlay on a positioned section around a non-positioned black footer.
  pseudoneg: page(`<style>footer{background:#000;position:relative;isolation:isolate;padding:24px}footer::before{content:'';position:absolute;inset:0;background:#fff;z-index:-1}</style><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  pseudoup: page(`<style>section{position:relative}section::before{content:'';position:absolute;inset:0;background:rgba(255,255,255,.95)}footer{background:#000;padding:24px}</style><section><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer></section>`),
  // A client site: a white overlay ::before switched off by a modifier class paints nothing, however
  // it is switched off; without the modifier, or with an opacity animation that may show it, it counts.
  pseudohidden: page(`<style>footer{background:#000;position:relative;padding:24px}footer::before{content:'';position:absolute;inset:0;background:#fff}footer.flat::before{display:none}</style><footer class="flat"><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  pseudoinvisible: page(`<style>footer{background:#000;position:relative;padding:24px}footer::before{content:'';position:absolute;inset:0;background:#fff}footer.flat::before{visibility:hidden}</style><footer class="flat"><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  pseudotransparent: page(`<style>footer{background:#000;position:relative;padding:24px}footer::before{content:'';position:absolute;inset:0;background:#fff}footer.flat::before{opacity:0;transition:opacity .2s}</style><footer class="flat"><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  pseudoshown: page(`<style>footer{background:#000;position:relative;padding:24px}footer::before{content:'';position:absolute;inset:0;background:#fff}footer.flat::before{display:none}</style><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  pseudopulse: page(`<style>footer{background:#000;position:relative;padding:24px}footer::before{content:'';position:absolute;inset:0;background:#fff}@keyframes pulse{50%{opacity:1}}footer.flat::before{opacity:0;animation:pulse 2s infinite}</style><footer class="flat"><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  // Round 3. ernstedt: a fixed feTurbulence grain over everything at z-index 1, under a z-50 banner.
  grain: page(`<style>body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.055;mix-blend-mode:multiply;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}</style>${banner('position:fixed;bottom:0;left:0;right:0;background:#fff;padding:8px;z-index:50')}<footer style="background:#000;padding:24px"><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  // A solid fixed overlay at z-index 1: the z-50 banner paints above it, a footer below the fold does
  // not (the overlay is fixed: it is over the footer whenever the footer is scrolled to).
  overlay: page(`<style>body::after{content:'';position:fixed;inset:0;z-index:1;background:rgba(255,255,255,.9)}</style>${banner('position:fixed;top:0;left:0;right:0;background:#fff;padding:8px;z-index:50')}<div style="height:2000px"></div><footer style="background:#000;padding:24px"><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  // Individual transform properties (Tailwind v4): a white sheet moved over the text with translate,
  // a 2px bar scaled over it, and an ancestor's translate capturing a fixed pseudo.
  translated: page(`<style>footer{position:relative;background:#000;padding:24px}footer::before{content:'';position:absolute;top:-300px;left:0;right:0;height:100%;background:#fff;translate:0 300px}</style><div style="height:320px"></div><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  scaled: page(`<style>footer{position:relative;background:#000;padding:24px 24px 120px}footer::before{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:#fff;scale:1 80}</style><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer>`),
  captured: page(`<style>section{translate:0 0}footer{background:#000;padding:24px 24px 24px 60px}footer::before{content:'';position:fixed;top:0;left:0;width:10px;height:100%;background:#fff}</style><section><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer></section>`),
  // The opaque footer sits at z-index -2, below a z-index -1 overlay on the section around it.
  negstack: page(`<style>section{position:relative}section::before{content:'';position:absolute;inset:0;background:rgba(255,255,255,.95);z-index:-1}footer{background:#000;position:relative;z-index:-2;padding:24px}</style><section><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer></section>`),
  // A scrolled box: its ::before scrolls with the content, over the text, though unscrolled maths miss it.
  scrolled: page(`<style>.box{position:relative;overflow:auto;height:100px;background:#000}.box::before{content:'';position:absolute;top:60px;left:0;right:0;height:24px;background:#fff}</style><div class="box"><div style="height:60px"></div><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div><div style="height:300px"></div></div><script>document.querySelector('.box').scrollTop = 50</script>`),
  // Round 4. A higher z-index around the text does not lift it above a pseudo that sits over the
  // opaque background: white over the black footer, under white text in a z-2 (or z-50) wrapper.
  ctxout: page(`<style>footer{background:#000;padding:24px}.e{position:relative}.e::before{content:"";position:absolute;inset:0;background:#fff;z-index:1}.t{position:relative;z-index:2}</style><footer><div class="e"><div class="t">${whiteLink}</div></div></footer>`),
  ctxfixed: page(`<style>body::after{content:"";position:fixed;inset:0;background:#fff;z-index:1}footer{background:#000;padding:24px}.t{position:relative;z-index:50}</style><footer><div class="t">${whiteLink}</div></footer>`),
  // Noise that is not faint grain: at full opacity, and an SVG that declares feTurbulence but
  // draws a plain white rect.
  noisefull: page(`<style>${PF}footer::before{content:"";position:absolute;inset:0;background-image:${NOISE_FILTERED}}</style><footer>${whiteLink}</footer>`),
  noiserect: page(`<style>${PF}footer::before{content:"";position:absolute;inset:0;opacity:.05;background-image:${NOISE_WHITE_RECT}}</style><footer>${whiteLink}</footer>`),
  // An ancestor's scale, transform or zoom moves an absolute pseudo away from its computed box: at
  // top 800px unscaled it is below the text, scaled by .5 it lands on it.
  ancscale: page(`<style>section{scale:.5;transform-origin:0 0}${ANC}</style><section><footer>${whiteLink}</footer></section>`),
  anctransform: page(`<style>section{transform:scale(.5);transform-origin:0 0}${ANC}</style><section><footer>${whiteLink}</footer></section>`),
  anczoom: page(`<style>section{zoom:.5}${ANC}</style><section><footer>${whiteLink}</footer></section>`),
  // Pseudos that paint without a background: a thick border, an inset shadow.
  pborder: page(`<style>${PF}footer::before{content:"";position:absolute;left:0;right:0;top:0;height:0;border-top:200px solid #fff}</style><footer>${whiteLink}</footer>`),
  pshadow: page(`<style>${PF}footer::before{content:"";position:absolute;inset:0;box-shadow:inset 0 0 0 400px #fff}</style><footer>${whiteLink}</footer>`),
  // content-visibility: auto on an ancestor captures a fixed pseudo like contain: paint.
  cvfixed: page(`<style>section{content-visibility:auto}footer{background:#000;padding:24px}footer::before{content:"";position:fixed;left:0;top:0;width:100%;height:100%;background:#fff}</style><div style="height:1500px"></div><section><footer>${whiteLink}</footer></section>`),
  // Round 5 (rr72f probe5). Faint grain adds up: eight 0.2 grain layers over the text (four
  // elements, each with a ::before and an ::after).
  grainstack: page(`<style>${PF}.w{position:relative}${['footer', '.a', '.b', '.c'].map((n) => `${n}::before,${n}::after{content:"";position:absolute;inset:0;opacity:.2;background-image:${BLACK_GRAIN}}`).join('')}</style><footer><div class="w a"><div class="w b"><div class="w c">${whiteLink}</div></div></div></footer>`),
  // A pseudo moved by its own zoom or offset-path; an absolute one under an ancestor's offset-path.
  pzoom: page(`<style>${PF}footer::before{content:"";position:absolute;left:0;top:0;width:10px;height:10px;background:#fff;zoom:30}</style><footer>${whiteLink}</footer>`),
  poffset: page(`<style>${PF}footer::before{content:"";position:absolute;left:0;top:800px;width:400px;height:100px;background:#fff;offset-path:path("M 200 -750 L 201 -750");offset-rotate:0deg}</style><footer>${whiteLink}</footer>`),
  ancoffset: page(`<style>section{offset-path:path("M 0 0 L 1 0")}${ANC}</style><section><footer>${whiteLink}</footer></section>`),
  // Things that capture a fixed pseudo: an identity filter, preserve-3d, will-change: translate,
  // offset-path. Uncaptured, the 300px strip at the left would miss the text at 400px.
  fixidfilter: page(fixedStrip('filter:grayscale(0)')),
  fixpreserve: page(fixedStrip('transform-style:preserve-3d')),
  fixwillchange: page(fixedStrip('will-change:translate')),
  fixoffset: page(fixedStrip('offset-path:path("M 0 0 L 1 0")')),
  // Paint that reaches outside the pseudo's box: a drop-shadow filter, text content, a big url()
  // content image in a 1px box; and a backdrop-filter that blacks out what is behind.
  pdropshadow: page(`<style>${PF}footer{margin-top:300px}footer::before{content:"";position:absolute;left:0;right:0;top:-200px;height:100px;background:#fff;filter:drop-shadow(0 220px 0 #fff)}</style><footer>${whiteLink}</footer>`),
  ptext: page(`<style>${PF}footer::before{content:"\\2588\\2588\\2588\\2588\\2588\\2588";position:absolute;left:0;top:0;font-size:120px;line-height:1;color:#fff}</style><footer>${whiteLink}</footer>`),
  pcontenturl: page(`<style>${PF}footer::before{content:${svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='2000' height='2000'><rect width='2000' height='2000' fill='white'/></svg>`)};position:absolute;left:0;top:0;width:1px;height:1px}</style><footer>${whiteLink}</footer>`),
  pbackdrop: page(`<style>${PF}footer::before{content:"";position:absolute;inset:0;backdrop-filter:brightness(0)}</style><footer>${whiteLink}</footer>`),
  // An absolute pseudo whose containing block is an inline element broken over two lines.
  inlinewrap: page(`<style>footer{background:#000;padding:24px;color:#fff}.e{position:relative}.e::before{content:"";position:absolute;left:0;top:0;width:100px;height:30px;background:#fff}</style><footer><div data-privacy-links style="width:420px;font:16px/20px sans-serif">Leading words here <span class="e"><a href="/integritet" style="color:#fff">Integritetspolicy</a> and then many more words to wrap onto the next line</span></div></footer>`),
  // A positioned display: contents element has no box (its rect is 0,0): its pseudo's box is unknown.
  contentsbox: page(`<style>footer{position:relative;background:#000;margin-top:300px}.c{display:contents;position:relative}.c::before{content:"";position:absolute;top:0;height:100px;width:100%;background:#fff}</style><footer><div class="c">${whiteLink}</div></footer>`),
  // Tailwind's resting box-shadow (0 0 #0000) paints nothing: a 1px bar at the top stays clear of the text.
  pclearshadow: page(`<style>${PF}footer::before{content:"";position:absolute;left:0;top:0;width:100%;height:1px;background:#333;box-shadow:0 0 #0000}</style><footer>${whiteLink}</footer>`),
  // Above the opaque footer: a backdrop-filter cannot reach the text; an identity filter on the footer.
  backdropup: page(`<style>section{backdrop-filter:blur(4px)}footer{background:#000;padding:24px;filter:grayscale(0)}</style><section><footer><div data-privacy-links><a href="/integritet" style="color:#fff">Integritetspolicy</a></div></footer></section>`),
  // #46 (knutssonsbil): main's absolute iframe fills the ratio box; the in-flow 320px wrapper does
  // not (the map shrinks, an empty band below); absolute inset-0 fills it again.
  ratiomain: page(ratioBox(`<iframe src="${MAPS}" style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>`)),
  ratiowrap: page(ratioBox(`<div style="display:grid;min-height:320px">${placeholder('')}</div>`)),
  ratiofill: page(ratioBox(`<div style="position:absolute;inset:0;display:grid">${placeholder('')}</div>`)),
  // Item 7: a button inside its (too wide) container but outside the viewport; a page that scrolls sideways.
  offbtn: page(`<section data-consent-banner style="position:absolute;top:0;left:0;width:1000px;background:#fff"><button data-consent-action="none" style="margin-left:900px">Neka</button></section>`),
  wide: page(`${banner()}<div style="width:2000px;height:10px"></div>`),
  // #43 (lbfastigheter): a parent 300px tall on phones with overflow:hidden cuts the placeholder's
  // buttons off below its edge; the same placeholder in a tall enough box (or one that scrolls) is fine.
  cutoff: page(`<style>.m{height:450px;overflow:hidden}@media (max-width:640px){.m{height:300px}}</style>${cutPlaceholder('m')}`),
  cutok: page(`<style>.m{height:450px;overflow:hidden}.s{height:200px;overflow:auto}</style>${cutPlaceholder('m')}${cutPlaceholder('s')}`),
  // body { overflow-x: hidden } (computed overflow-y: auto) with the embed below the fold: it scrolls.
  cutokx: page(`<style>html,body{height:100%}body{overflow-x:hidden}</style><div style="height:900px"></div>${cutPlaceholder('m')}`),
  // The button fits, but the row's "Visa alltid" and "Öppna" wrap below the box's edge.
  cutrow: page(`<style>.m{height:300px;overflow:hidden}</style><div class="m"><div data-consent-embed="google-maps"><p style="height:270px;margin:0">Google Maps</p><button data-load>Visa</button><br><label><input type="checkbox" data-remember> Visa alltid</label><br><a data-open href="${MAPS}">Öppna</a></div></div>`),
}

const dir = mkdtempSync(join(tmpdir(), 'checks-fixtures-'))
for (const [name, html] of Object.entries(FIXTURES)) {
  mkdirSync(join(dir, name))
  writeFileSync(join(dir, name, 'index.html'), html)
}
// A live site answers in 100 ms or more, and the old page runs until the new one commits; this one
// answers at once unless a fixture needs the old page to keep running through a navigation.
const SLOW: Record<string, number> = { busy: 600 }
const server = createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0]!.replace(/^\/|\/$/g, '')
  setTimeout(() => {
    try {
      const body = readFileSync(join(dir, name, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body)
    } catch {
      res.writeHead(404).end('nope')
    }
  }, SLOW[name] ?? 0)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const address = server.address()
const BASE = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

const browser = await chromium.launch()
let failed = false
const expect = (cond: boolean, what: string, detail: unknown) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(detail)}`)
  if (!cond) failed = true
}
try {
  const req = async (path: string) => (await checkRequests(browser, BASE, [path], { stub: true }))[0]!

  for (const path of ['/ok/']) {
    const r = await req(path)
    expect(r.banner && r.ok, `${path} control: banner shown, ok`, r)
  }
  for (const path of ['/transparent/', '/covered/', '/offscreen/']) {
    const r = await req(path)
    expect(!r.banner && !r.ok, `${path} banner not shown`, r)
  }
  {
    let r: unknown
    try {
      r = await req('/two/')
      const two = r as Awaited<ReturnType<typeof req>>
      expect(!two.ok && two.banners === 2 && /2 banners/.test(two.bannerProblem ?? ''), '/two/ reported, not thrown', r)
    } catch (e) {
      expect(false, '/two/ reported, not thrown', String(e).split('\n')[0])
    }
  }
  {
    const r = await req('/lazy/')
    expect(r.blocked.some((b) => b.startsWith('in DOM, not requested:')) && !r.ok, '/lazy/ data-src iframe counted', r.blocked)
  }
  for (const path of ['/late/', '/smooth/']) {
    const r = await req(path)
    expect(r.blocked.some((b) => b.startsWith('https://www.googletagmanager.com/')) && !r.ok, `${path} mid-page loader seen`, r.blocked)
  }

  const paths = async (path: string) => (await checkConsentPaths(browser, BASE, [path]))[0]!
  {
    const r = await paths('/oneoff/')
    expect(r.visaLoadsOnlyClicked && r.filterKept === null, '/oneoff/ control: one-off Visa passes, filter not asserted', r)
  }
  {
    const r = await paths('/busy/')
    expect(r.visaLoadsOnlyClicked, '/busy/ control: a map still loading tiles when the reload starts passes', r)
  }
  {
    const r = await paths('/ghost/')
    expect(!r.visaLoadsOnlyClicked && r.notes.some((n) => /after reload active\+iframes=0 blocked=[1-9]/.test(n)), '/ghost/ reloaded page that requests the registry with no embed fails', r)
  }
  {
    const r = await paths('/sticky/')
    expect(!r.visaLoadsOnlyClicked, '/sticky/ Visa that survives a reload fails', r)
  }
  {
    const r = await paths('/other/')
    expect(!r.visaLoadsOnlyClicked, '/other/ Visa that loads another service fails', r)
  }
  {
    const r = await paths('/flat/')
    expect(!r.visaLoadsOnlyClicked, '/flat/ Visa whose iframe is 0px tall fails', r)
  }
  {
    const r = await paths('/collapsed/')
    expect(!r.visaLoadsOnlyClicked && r.notes.some((n) => / \d+x0px/.test(n)), '/collapsed/ absolute iframe in an embed with no height fails', r)
  }

  {
    const started = Date.now()
    const r = await paths('/widget/')
    const ms = Date.now() - started
    expect(r.visaLoadsOnlyClicked && r.rememberAutoShows && r.nekaLoadsNothing && r.openHref === null && ms < 60_000, `/widget/ widget first: passes, no open link, no hang (${ms} ms; ~16 s of fixed waits)`, r)
  }
  {
    const rs = await checkConsentPaths(browser, BASE, ['/mixa/', '/mixb/'])
    expect(rs.every((r) => r.visaLoadsOnlyClicked && r.rememberAutoShows && r.nekaLoadsNothing), '/mixa/ /mixb/ Visa alltid loads its own service only', rs)
  }
  {
    const rs = await checkConsentPaths(browser, BASE, ['/greedya/', '/greedyb/'])
    expect(rs.every((r) => !r.rememberAutoShows), '/greedya/ /greedyb/ Visa alltid that loads other services fails', rs)
  }

  {
    const rows = await checkClip(browser, BASE, ['/offbtn/'], [360])
    expect(rows.some((r) => r.button === 'Neka' && r.clipped), '/offbtn/ button outside the viewport', rows)
  }
  {
    const rows = await checkClip(browser, BASE, ['/wide/'], [360])
    expect(rows.some((r) => r.kind === 'page' && r.clipped), '/wide/ horizontal page scroll', rows)
  }
  {
    const rows = await checkClip(browser, BASE, ['/cutoff/'], [360, 1280])
    expect(rows.some((r) => r.width === 360 && r.button === 'Visa' && r.clipped && r.cut), '/cutoff/ Visa cut off by an overflow:hidden parent at 360px', rows)
    expect(rows.every((r) => r.width !== 1280 || !r.clipped), '/cutoff/ at 1280px is not clipped', rows)
  }
  {
    const rows = await checkClip(browser, BASE, ['/cutrow/'], [360])
    expect(rows.some((r) => r.button === 'Visa' && r.cut), '/cutrow/ the Visa row cut off below the button', rows)
  }
  {
    const rows = await checkClip(browser, BASE, ['/cutok/', '/cutokx/'], [360])
    expect(rows.every((r) => !r.clipped), '/cutok/ /cutokx/ a tall enough box, or one that scrolls (overflow-x:hidden body included), is not clipped', rows)
  }

  {
    const ph = async (path: string) => (await checkContrast(browser, BASE, [path], { stub: true })).filter((r) => r.kind === 'placeholder')
    const dark = await ph('/darkph/')
    // The Visa button keeps its own background (btn-primary in the package): the other three fail.
    expect(dark.length === 4 && dark.filter((r) => r.button !== 'Visa').every((r) => !r.ok), '/darkph/ light text on the light placeholder: info text, label and open link fail (#46)', dark)
    const ok = await ph('/okph/')
    expect(ok.length === 4 && ok.every((r) => r.ok), '/okph/ control: a readable placeholder passes', ok)
  }
  {
    const links = async (path: string) => (await checkContrast(browser, BASE, [path], { stub: true })).filter((r) => r.kind === 'links')
    const foot = await links('/gradfoot/')
    expect(foot.length === 2 && foot.every((r) => r.ok && !r.indeterminate && r.note === 'gradient, worst stop' && r.ratio > 5), '/gradfoot/ white/70 on a var() gradient of two blues passes against its worst stop (nanolfs-villan)', foot)
    const light = await links('/gradfail/')
    expect(light.length === 2 && light.every((r) => !r.ok && !r.indeterminate && r.ratio < 1.5), '/gradfail/ a gradient ending near white fails, determinately', light)
    const photo = await links('/gradphoto/')
    expect(photo.length === 2 && photo.every((r) => !r.ok && r.indeterminate === 'background image behind the text'), '/gradphoto/ a photo over the gradient stays indeterminate', photo)
    const hsl = await links('/gradhsl/')
    expect(hsl.length === 2 && hsl.every((r) => !r.ok && !r.indeterminate && r.ratio > 3.5 && r.ratio < 3.8 && r.note === 'gradient, worst point between stops; interpolated in hsl longer hue'), '/gradhsl/ hsl longer hue is mixed by the page: white fails on the yellow it passes, about 3.64:1', hsl)
    const blend = await links('/gradblend/')
    expect(blend.length === 2 && blend.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: background-blend-mode'), '/gradblend/ background-blend-mode is indeterminate', blend)
    const clip = await links('/gradclip/')
    expect(clip.length === 2 && clip.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: background-clip'), '/gradclip/ background-clip: text is indeterminate', clip)
    const filter = await links('/gradfilter/')
    expect(filter.length === 2 && filter.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: filter'), '/gradfilter/ a filter on an ancestor is indeterminate', filter)
    const fade = await links('/gradfade/')
    expect(fade.length === 2 && fade.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: opacity'), '/gradfade/ opacity on the footer that has the background is indeterminate', fade)
    const faded = await links('/linksfade/')
    const want = wcagContrast({ r: 0.7 * 255 + 0.3 * 0, g: 0.7 * 255 + 0.3 * 0x37, b: 0.7 * 255 + 0.3 * 0x5f }, { r: 0, g: 0x37, b: 0x5f })
    expect(faded.length === 2 && faded.every((r) => r.ok && !r.indeterminate && Math.abs(r.ratio - want) < 0.05), '/linksfade/ opacity-70 on the background-less links wrapper fades the text and is measured', { faded, want })

    const anim = await checkContrast(browser, BASE, ['/animated/'], { stub: true })
    expect(
      anim.filter((r) => r.kind === 'placeholder').length === 4 && anim.filter((r) => r.kind === 'links').length === 1 && anim.every((r) => r.ok && !r.indeterminate),
      '/animated/ data-animate wrappers below the fold (opacity 0 until scrolled to, one slow) are measured settled: ok (ernstedt, knutssonsbil, …)',
      anim,
    )
    const hair = await links('/hairline/')
    expect(hair.length === 1 && hair.every((r) => r.ok && !r.indeterminate), '/hairline/ a 1px ::before hairline and a width-0 a::after underline are not over the text (ahatrafikskola)', hair)
    for (const [path, what] of [['/pseudohidden/', 'display: none'], ['/pseudoinvisible/', 'visibility: hidden'], ['/pseudotransparent/', 'opacity: 0 at rest']] as const) {
      const rows = await links(path)
      expect(rows.length === 1 && rows.every((r) => r.ok && !r.indeterminate), `${path} a white ::before overlay switched off with ${what} paints nothing`, rows)
    }
    for (const [path, what] of [['/pseudoshown/', 'the same overlay without the modifier'], ['/pseudopulse/', 'an overlay at opacity 0 under an infinite opacity animation']] as const) {
      const rows = await links(path)
      expect(rows.length === 1 && rows.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: positioned ::before with a background'), `${path} ${what} is over the text: indeterminate`, rows)
    }
    for (const [path, what] of [['/pseudoneg/', 'a z-index -1 ::before inside an isolated footer'], ['/pseudoup/', 'an overlay ::before on a positioned ancestor above the opaque footer']] as const) {
      const rows = await links(path)
      expect(rows.length === 1 && rows.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: positioned ::before with a background'), `${path} ${what} is over the text: indeterminate`, rows)
    }
    {
      const all = await checkContrast(browser, BASE, ['/grain/'], { stub: true })
      expect(all.filter((r) => r.kind === 'banner').length === 2 && all.filter((r) => r.kind === 'links').length === 1 && all.every((r) => r.ok && !r.indeterminate), '/grain/ a fixed feTurbulence grain at z-index 1 under a z-50 banner does not count (ernstedt)', all)
    }
    {
      const all = await checkContrast(browser, BASE, ['/overlay/'], { stub: true })
      const ban = all.filter((r) => r.kind === 'banner')
      const lk = all.filter((r) => r.kind === 'links')
      // Without a model of where the opaque background sits in the stacking order, a z-50 banner over
      // a solid fixed overlay is not proven above it: indeterminate (round 4: textAbove dropped).
      expect(ban.length === 2 && ban.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: positioned ::after with a background'), '/overlay/ a solid fixed overlay counts even under a z-50 banner', ban)
      expect(lk.length === 1 && lk.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: positioned ::after with a background'), '/overlay/ a fixed overlay is over a footer below the fold too', lk)
    }
    for (const [path, what] of [
      ['/translated/', 'a sheet moved over the text with translate'],
      ['/scaled/', 'a 2px bar scaled over the text'],
      ['/captured/', "a fixed pseudo captured by an ancestor's translate"],
      ['/negstack/', 'a z-index -1 overlay above an opaque footer at z-index -2'],
      ['/scrolled/', "a pseudo in a scrolled box's content"],
      ['/ctxout/', 'a white pseudo over the black footer under a z-2 text wrapper'],
      ['/noisefull/', 'feTurbulence noise at full opacity'],
      ['/noiserect/', 'an SVG that declares feTurbulence but draws a white rect'],
      ['/ancscale/', "an absolute pseudo moved by an ancestor's scale"],
      ['/anctransform/', "an absolute pseudo moved by an ancestor's transform"],
      ['/anczoom/', "an absolute pseudo moved by an ancestor's zoom"],
      ['/pborder/', 'a pseudo painting with a thick border'],
      ['/pshadow/', 'a pseudo painting with an inset shadow'],
      ['/cvfixed/', 'a fixed pseudo captured by content-visibility: auto'],
      ['/pzoom/', 'a pseudo moved by its own zoom'],
      ['/poffset/', 'a pseudo moved by its own offset-path'],
      ['/ancoffset/', "an absolute pseudo under an ancestor's offset-path"],
      ['/fixidfilter/', 'a fixed pseudo captured by filter: grayscale(0)'],
      ['/fixpreserve/', 'a fixed pseudo captured by transform-style: preserve-3d'],
      ['/fixwillchange/', 'a fixed pseudo captured by will-change: translate'],
      ['/fixoffset/', 'a fixed pseudo captured by offset-path'],
      ['/pdropshadow/', 'a drop-shadow filter painting outside the box'],
      ['/ptext/', 'text content overflowing the box'],
      ['/pcontenturl/', 'a url() content image overflowing a 1px box'],
      ['/pbackdrop/', 'a backdrop-filter that blacks out the background'],
      ['/inlinewrap/', 'an absolute pseudo of an inline element broken over two lines'],
      ['/contentsbox/', 'an absolute pseudo of a positioned display: contents element'],
    ] as const) {
      const rows = await links(path)
      expect(rows.length === 1 && rows.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: positioned ::before with a background'), `${path} ${what}: indeterminate`, rows)
    }
    {
      const rows = await links('/grainstack/')
      expect(rows.length === 1 && rows.every((r) => !r.ok && /^effect on the text or its background: positioned ::(before|after) with a background/.test(r.indeterminate ?? '')), '/grainstack/ eight 0.2 grain layers add up past 0.2: indeterminate', rows)
      const clear = await links('/pclearshadow/')
      expect(clear.length === 1 && clear.every((r) => r.ok && !r.indeterminate), "/pclearshadow/ Tailwind's transparent resting box-shadow paints nothing", clear)
    }
    {
      const rows = await links('/ctxfixed/')
      expect(rows.length === 1 && rows.every((r) => !r.ok && r.indeterminate === 'effect on the text or its background: positioned ::after with a background'), '/ctxfixed/ a white fixed overlay under a z-50 text wrapper without a background: indeterminate', rows)
    }
    const up = await links('/backdropup/')
    expect(up.length === 1 && up.every((r) => r.ok && !r.indeterminate), '/backdropup/ backdrop-filter above the opaque layer and filter: grayscale(0) do not count', up)
  }
  {
    const boxes = (path: string) => checkEmbedBoxes(browser, BASE, [path], [360, 1280], { stub: true })
    // Main and branch are different fixture pages here: compare them as one path.
    const as = (bs: Awaited<ReturnType<typeof boxes>>) => bs.map((b) => ({ ...b, path: '/kontakt' }))
    const main = as(await boxes('/ratiomain/'))
    const wrap = compareEmbedHeights(main, as(await boxes('/ratiowrap/')))
    expect(main.length === 2 && wrap.rows.length === 2 && !wrap.rows.find((r) => r.width === 1280)!.ok, '/ratiowrap/ an in-flow wrapper in a padding-ratio box is shorter than main at 1280px (#46, knutssonsbil)', { main, wrap })
    const fill = compareEmbedHeights(main, as(await boxes('/ratiofill/')))
    expect(fill.rows.length === 2 && fill.rows.every((r) => r.ok), '/ratiofill/ control: absolute inset-0 fills the box as main did', fill)
  }
} finally {
  await browser.close()
  server.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
