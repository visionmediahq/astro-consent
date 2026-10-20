## Vad ändras

- Typsnitten ({{families}}) laddas från sajten själv i stället för från Google Fonts. Besökarens webbläsare skickar inga anrop till Google (`fonts.googleapis.com`, `fonts.gstatic.com`) när sidan visas, och texten ser ut som förut.
- `public/fonts/`: typsnittsfilerna (woff2), precis som Google Fonts levererar dem, och varje familjs licens.
- `src/styles/fonts.css`: typsnitten, importerad från sajtens CSS. Länkarna till Google Fonts är borttagna.

Filer:

{{files}}

## Så testar du

1. Öppna https://{{domain}} i ett privat fönster med webbläsarens nätverksflik öppen.
2. Filtrera på `fonts.g`: inga anrop till Google.
3. Filtrera på `woff2`: typsnitten hämtas från `/fonts/` och svarar 200.
4. Jämför rubriker och brödtext med sajten före ändringen: samma typsnitt, å, ä och ö som förut.

## Kontroller

Kontrollerat lokalt med `ci/rollout` (astro-consent):

{{steps}}

Skärmbilder (360/1280 px):

{{screenshots}}

**Mergas efter verifiering och livekontroll.**

## Relaterade ärenden

{{issues}}
