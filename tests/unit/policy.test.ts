// #89: the node-free text helpers ConsentPolicy renders with.
import { expect, test } from 'vitest'
import { fill, monthsOf, splitAt } from '../../src/policy'
import { MAX_AGE_MS } from '../../src/store'

const DAY = 24 * 3600 * 1000

test('monthsOf gives whole months, not only multiples of 12 (review of #145)', () => {
  expect(monthsOf(MAX_AGE_MS)).toBe(12)
  expect(monthsOf(365 * DAY)).toBe(12)
  expect(monthsOf(183 * DAY)).toBe(6)
  expect(monthsOf(548 * DAY)).toBe(18)
  expect(monthsOf(30 * DAY)).toBe(1)
})

test('fill replaces known placeholders and leaves unknown ones', () => {
  expect(fill('{name} ({org_number})', { name: 'Kund AB', org_number: '556677-8899' })).toBe('Kund AB (556677-8899)')
  expect(fill('Hej {email}', { name: 'x' })).toBe('Hej {email}')
})

test('splitAt fills the text and splits it around one placeholder, so it can be a link', () => {
  expect(splitAt('{name}: skriv till {email}.', 'email', { name: 'Kund AB' })).toEqual(['Kund AB: skriv till ', '.'])
  expect(splitAt('{email}', 'email', {})).toEqual(['', ''])
  expect(splitAt('Utan adress.', 'email', {})).toEqual(['Utan adress.', ''])
})
