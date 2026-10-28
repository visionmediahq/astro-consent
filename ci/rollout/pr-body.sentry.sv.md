## Vad ändras

- Skriptet för felrapporteringen (Sentry, som skickar fel till vår GlitchTip när sajtens `PUBLIC_GLITCHTIP_DSN` är satt) hämtas nu från sajten själv: `{{sentrySrc}}`. Inget syns på sidan och inget annat ändras.{{#sentrycdn}}
- Förut hämtades det från Sentrys CDN i USA (`browser.sentry-cdn.com`) vid varje sidvisning, innan besökaren hunnit välja något. Det anropet försvinner.{{/sentrycdn}}{{#sentryjsdelivr}}
- Den gamla adressen (`cdn.jsdelivr.net`) svarade 404, så felrapporteringen har inte fungerat. Den börjar fungera när sajtens DSN är satt.{{/sentryjsdelivr}}
- `{{sentryFile}}`: Sentrys egen fil, version {{sentryVersion}}, kontrollerad mot den kontrollsumma Sentry publicerar för den.

Filer:

{{files}}

## Så testar du

1. Öppna https://{{domain}} i ett privat fönster med webbläsarens nätverksflik öppen.
2. Filtrera på `sentry`: inga anrop till `browser.sentry-cdn.com` eller `cdn.jsdelivr.net`. Där felrapporteringen är påslagen hämtas `{{sentrySrc}}` från sajten själv och svarar 200.
3. Sajten ser ut och fungerar som förut.

## Kontroller

Kontrollerat lokalt med `ci/rollout` ({{tool}}):

{{steps}}

Skärmbilder (360/1280 px):

{{screenshots}}

**Mergas efter verifiering och livekontroll.**

## Relaterade ärenden

{{issues}}
