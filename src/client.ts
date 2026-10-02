/// <reference path="./env.d.ts" />
// Browser runtime, injected once per page by the integration. Owns the banner, storage, events
// and cross-tab sync. Site scripts use the exported hasConsent / onConsent / openSettings.
import config from 'virtual:astro-consent/config'
import type { ConsentConfig } from './types'
import type { Category, ServiceSlug, Target } from './services'
import * as store from './store'
import type { Choice, ConsentRecord } from './store'

export interface Runtime {
  config: ConsentConfig
  /** The consent record in effect on this page, or null when the visitor has not chosen. */
  readonly record: ConsentRecord | null
  hasConsent(target: Target): boolean
  /** Runs `fn` now if `target` is granted, otherwise once when it becomes granted. Never twice. */
  onConsent(target: Target, fn: () => void): void
  openSettings(): void
}

type Origin = Choice | 'embed'

function create(): Runtime {
  let storage: Storage | null
  try {
    storage = window.localStorage
  } catch {
    storage = null
  }

  // Never written on load: a stale or corrupt value is ignored, not replaced.
  const state: { record: ConsentRecord | null } = {
    record: store.readRecord(storage, config.consentVersion, new Date()),
  }
  /** Targets actually in effect on this page: an activated embed, or an onConsent callback that ran. */
  const active = new Set<Target>()
  const listeners: Array<{ target: Target; fn: () => void }> = []

  // Null on a page without <ConsentBanner /> (custom layouts): banner functions are no-ops there.
  const bannerEl = document.querySelector<HTMLElement>('[data-consent-banner]')
  const mainEl = bannerEl?.querySelector<HTMLElement>('[data-consent-main]') ?? null
  const form = bannerEl?.querySelector<HTMLFormElement>('form[data-consent-settings]') ?? null
  /** The footer link that opened the banner, if one did: focus goes back to it when the banner closes. */
  let opener: HTMLElement | null = null

  /** Only targets this site declared in privacy.json can ever be granted. */
  function known(target: string): target is Target {
    return (
      target === 'necessary' ||
      (config.categories as string[]).includes(target) ||
      (config.services as string[]).includes(target)
    )
  }

  const warned = new Set<string>()
  function warnUnknown(caller: string, target: string): void {
    if (warned.has(target)) return
    warned.add(target)
    console.warn(
      `[astro-consent] ${caller}("${target}"): "${target}" is not listed in src/data/privacy.json, ` +
        'so it can never be granted. Add the service to "services" there.',
    )
  }

  /** Internal check: does the record grant this target? */
  const granted = (target: Target): boolean => known(target) && store.hasConsent(state.record, target)

  /**
   * Public check. A site script that gates on it is assumed to have loaded the service, so the
   * target counts as active and a later withdrawal reloads the page and clears its cookies.
   */
  function hasConsent(target: Target): boolean {
    if (!known(target)) {
      warnUnknown('hasConsent', target)
      return false
    }
    const result = granted(target)
    if (result && target !== 'necessary') active.add(target)
    return result
  }

  function run(target: Target, fn: () => void): void {
    active.add(target)
    try {
      fn()
    } catch (error) {
      // A site callback that throws must not stop the banner or the other callbacks.
      // Rethrow outside this call stack so the error is still reported.
      queueMicrotask(() => {
        throw error
      })
    }
  }

  function onConsent(target: Target, fn: () => void): void {
    if (!known(target)) {
      warnUnknown('onConsent', target) // would never fire: say so instead of failing silently
      return
    }
    if (granted(target)) run(target, fn)
    else listeners.push({ target, fn })
  }

  function fire(): void {
    for (const listener of [...listeners]) {
      if (!granted(listener.target)) continue
      listeners.splice(listeners.indexOf(listener), 1)
      run(listener.target, listener.fn)
    }
  }

  /** Swaps an embed's placeholder for its iframe. */
  function activate(el: HTMLElement): void {
    const template = el.querySelector<HTMLTemplateElement>('template[data-payload]')
    if (!template) return
    el.querySelector('[data-placeholder]')?.remove()
    el.append(template.content.cloneNode(true))
    template.remove()
    el.dataset.active = ''
    active.add(el.dataset.consentEmbed as ServiceSlug)
  }

  /** Activates every embed the RECORD grants. A one-off "Visa" is never generalised to other embeds. */
  function applyGrants(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-consent-embed]:not([data-active])')) {
      if (granted(el.dataset.consentEmbed as ServiceSlug)) activate(el)
    }
  }

  function loadEmbed(el: HTMLElement): void {
    const slug = el.dataset.consentEmbed as ServiceSlug
    const remember = el.querySelector<HTMLInputElement>('[data-remember]')?.checked ?? false
    if (!remember) {
      activate(el) // this element only; nothing stored, no event
      return
    }
    const base = state.record
    save(
      {
        id: base?.id ?? store.newId(crypto),
        version: config.consentVersion,
        saved_at: new Date().toISOString(),
        choice: base?.choice ?? null, // an embed grant never answers the banner
        categories: base?.categories ?? ['necessary'],
        services: [...new Set([...(base?.services ?? []), slug])],
      },
      'embed',
    )
  }

  function emit(name: string, record: ConsentRecord | null): void {
    window.dispatchEvent(new CustomEvent(name, { detail: { record } }))
  }

  /** A loaded script cannot be unloaded: clear what the withdrawn services stored, then reload. */
  function withdraw(lost: Target[]): void {
    store.deleteCookies(document, location.hostname, location.protocol === 'https:', store.cookiesFor(lost))
    location.reload()
  }

  function afterChange(before: ConsentRecord | null, next: ConsentRecord | null): void {
    const lost = store.lostConsent(before, next, active)
    if (lost.length > 0) {
      withdraw(lost)
      return
    }
    applyGrants()
    fire()
  }

  function save(next: ConsentRecord, origin: Origin): void {
    const before = state.record
    state.record = next
    store.writeRecord(storage, next) // false in private mode: the choice then lasts for this page only
    emit('vm:consent-changed', next)
    window.umami?.track('consent', { choice: origin })
    if (config.logEndpoint) {
      try {
        navigator.sendBeacon(config.logEndpoint, JSON.stringify({ site: config.site, ...next }))
      } catch {
        // Fire-and-forget: a failed beacon never affects the visitor.
      }
    }
    afterChange(before, next)
  }

  function choose(choice: Choice, categories: readonly string[], services: ServiceSlug[]): void {
    const granted = config.categories.filter(
      (category): category is Category => category !== 'necessary' && categories.includes(category),
    )
    save(
      {
        id: state.record?.id ?? store.newId(crypto),
        version: config.consentVersion,
        saved_at: new Date().toISOString(),
        choice,
        categories: ['necessary', ...granted],
        services: choice === 'none' ? [] : services,
      },
      choice,
    )
    hideBanner()
  }

  function showView(view: 'main' | 'settings'): void {
    if (!bannerEl || !form || !mainEl) return // notice mode has a single view
    bannerEl.dataset.view = view
    mainEl.hidden = view !== 'main'
    form.hidden = view !== 'settings'
    if (view !== 'settings') return
    for (const group of form.querySelectorAll<HTMLElement>('[data-consent-category]')) {
      const category = group.dataset.consentCategory as Category
      const input = group.querySelector<HTMLInputElement>(`input[name="${category}"]`)
      if (input && !input.disabled) input.checked = granted(category)
    }
    for (const row of form.querySelectorAll<HTMLElement>('[data-consent-service]')) {
      const granted = state.record?.services.includes(row.dataset.consentService as ServiceSlug) ?? false
      row.hidden = !granted
      const input = row.querySelector<HTMLInputElement>('input')
      if (input) input.checked = granted
    }
  }

  function showBanner(): void {
    if (bannerEl) bannerEl.hidden = false // never moves focus
  }

  function hideBanner(): void {
    if (!bannerEl) return
    // Give focus back to the footer link that opened the banner, but only when focus is still in
    // the banner (or nowhere). If the visitor has moved on, e.g. into a form, leave them there:
    // another tab's change can close this banner at any moment.
    const focused = document.activeElement
    const focusIsOurs = !focused || focused === document.body || bannerEl.contains(focused)
    bannerEl.hidden = true
    showView('main')
    if (opener?.isConnected && focusIsOurs) opener.focus()
    opener = null
  }

  function openSettings(): void {
    if (!bannerEl) return
    showBanner()
    showView('settings')
    // Focus inside the visible view: the first button in document order is in the hidden main view.
    const scope = form && !form.hidden ? form : bannerEl
    scope.querySelector<HTMLElement>('input:not([disabled]), button')?.focus()
  }

  function syncBanner(): void {
    if (!bannerEl) return
    const needsAnswer = !state.record || state.record.choice === null
    if (needsAnswer) showBanner()
    // Never close a settings view the visitor has open.
    else if (bannerEl.hidden || bannerEl.dataset.view !== 'settings') hideBanner()
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const trigger = target.closest<HTMLElement>('[data-consent-open]')
    if (trigger) {
      opener = trigger
      openSettings()
      return
    }
    if (target.closest('[data-load]')) {
      const embed = target.closest<HTMLElement>('[data-consent-embed]')
      if (embed) loadEmbed(embed)
      return
    }
    const actionEl = target.closest<HTMLElement>('[data-consent-banner] [data-consent-action]')
    switch (actionEl?.dataset.consentAction) {
      case 'notice_ok':
        choose('notice_ok', [], [])
        break
      case 'all':
        choose('all', config.categories, state.record?.services ?? [])
        break
      case 'none':
        choose('none', [], [])
        break
      case 'settings':
        showView('settings')
        break
      case 'back':
        showView('main')
        break
      // 'custom' is the submit button: handled by the submit listener.
    }
  })

  document.addEventListener('submit', (event) => {
    if (!form || event.target !== form) return
    event.preventDefault()
    const categories: string[] = []
    const services: ServiceSlug[] = []
    for (const input of form.querySelectorAll<HTMLInputElement>('input:checked')) {
      if (input.name.startsWith('service:')) services.push(input.name.slice('service:'.length) as ServiceSlug)
      else categories.push(input.name)
    }
    choose('custom', categories, services)
  })

  // Another tab changed the record. Adopt it, and never write: a write here would echo back to
  // the other tab and could start a reload loop.
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== storage) return // sessionStorage events are not ours
    if (event.key !== null && event.key !== store.STORAGE_KEY) return // key null = localStorage.clear()
    const before = state.record
    const after = event.key === null ? null : store.parseRecord(event.newValue, config.consentVersion, new Date())
    state.record = after
    if (store.lostConsent(before, after, active).length > 0) {
      // Reload only. The tab where the visitor withdrew deletes the cookies.
      location.reload()
      return
    }
    applyGrants()
    fire()
    syncBanner()
    // A settings view left open here must show the new truth, or "Spara val" would save stale
    // toggles and could re-grant what the visitor just withdrew in the other tab.
    if (bannerEl && !bannerEl.hidden && bannerEl.dataset.view === 'settings') showView('settings')
  })

  syncBanner()
  applyGrants()
  emit('vm:consent-ready', state.record)

  return {
    config,
    get record() {
      return state.record
    },
    hasConsent,
    onConsent,
    openSettings,
  }
}

// A bundled site shares one copy of this module; the guard covers a second copy loaded some other way.
export const runtime: Runtime = window.__vmConsent ?? (window.__vmConsent = create())

export const hasConsent = (target: Target): boolean => runtime.hasConsent(target)
export const onConsent = (target: Target, fn: () => void): void => runtime.onConsent(target, fn)
export const openSettings = (): void => runtime.openSettings()
