# Changelog

## 1.0.0

First release.

- `consent()` Astro integration: validates `src/data/privacy.json`, serves it to components and the
  browser through one virtual module, injects the runtime once per page, and fails the build when a
  `<ConsentEmbed>` names a service that is not listed.
- `<ConsentBanner />`: Swedish, themed by the site's DaisyUI theme. Consent mode (Acceptera alla /
  Neka / Inställningar) when the site uses registry services, notice mode (OK) when it uses none.
- `<ConsentEmbed>`: click-to-load iframe with a placeholder, a per-service "Visa alltid" choice and a
  link that works without JavaScript.
  The link for Maps Embed API URLs is rebuilt from their parameters and never carries the API key.
- `<PrivacyLinks />`: footer link that reopens the settings, plus the policy link when configured.
- Script API: `hasConsent`, `onConsent`, `openSettings`; events `vm:consent-ready` and
  `vm:consent-changed`. A target the site has not declared in `privacy.json` logs one warning and is
  never granted. A service read through `hasConsent` counts as loaded, so withdrawing it reloads the
  page. The script API type-checks inside a site's own `tsc` / `astro check`.
- The build-time check follows embeds imported under another name and reads live markup only, so a
  commented-out embed does not fail a build.
- Service registry: Google Maps, Google Analytics, Google Ads, Meta Pixel.
- Withdrawal deletes the withdrawn services' first-party cookies and reloads once; other tabs follow.
- Optional `log_endpoint` beacon for a future central consent log.

Not supported: Astro view transitions (`<ClientRouter />`).
