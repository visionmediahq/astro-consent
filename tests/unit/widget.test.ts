import { expect, test } from 'vitest'
import { widgetError } from '../../src/widget'

const F = '/flode/'
const OK = 'https://elfsightcdn.com/platform.js'
const DIV = '<div class="elfsight-app-a" data-elfsight-app-lazy></div>'

test('a registry https script and an inert slot pass', () => {
  expect(widgetError(F, 'elfsight', OK, DIV)).toBeNull()
})

test('the script must be an absolute https URL', () => {
  expect(widgetError(F, 'elfsight', '/platform.js', DIV)).toMatch(/absolute URL/)
  expect(widgetError(F, 'elfsight', 'http://elfsightcdn.com/platform.js', DIV)).toMatch(/https:/)
})

test('the script must belong to the widget service, judged without the query', () => {
  expect(widgetError(F, 'elfsight', 'https://maps.googleapis.com/maps/api/js', DIV)).toMatch(/google-maps/)
  expect(widgetError(F, 'elfsight', 'https://cdn.example.test/w.js', DIV)).toMatch(/no service/)
  expect(widgetError(F, 'elfsight', 'https://evil.test/x.js?u=elfsightcdn.com', DIV)).toMatch(/no service/)
})

test('the script must be on the service\'s own host, not merely contain it', () => {
  expect(widgetError(F, 'elfsight', 'https://elfsight.com.cdn.example/x.js', DIV)).toMatch(/no service|does not belong/)
  expect(widgetError(F, 'elfsight', 'https://kund.se/vendor/elfsightcdn.com/platform.js', DIV)).toMatch(/no service|does not belong/)
  expect(widgetError(F, 'elfsight', 'https://static.elfsight.com/platform/platform.js', DIV)).toBeNull()
  expect(widgetError(F, 'elfsight', OK, DIV)).toBeNull()
})

test.each(['<script src="x"></script>', '<SCRIPT>1</SCRIPT>', '<script type="module" src="/_astro/a.js"></script>'])(
  'a <script> in the slot fails: %s',
  (markup) => {
    expect(widgetError(F, 'elfsight', OK, DIV + markup)).toMatch(/no <script>/)
  },
)

test('the message names the page and the service', () => {
  expect(widgetError('src/pages/kontakt.astro', 'elfsight', 'http://x', DIV)).toMatch(/src\/pages\/kontakt\.astro.*elfsight/)
})
