import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { CATEGORIES, SERVICES, generateServicesJson, isCategory, matchesRegistry } from '../../src/services'

test('CATEGORIES is necessary, external, statistics, marketing in that order', () => {
  expect([...CATEGORIES]).toEqual(['necessary', 'external', 'statistics', 'marketing'])
})

test('every service has a non-necessary category, a vendor, a Swedish description and at least one match pattern', () => {
  for (const service of Object.values(SERVICES)) {
    expect(['external', 'statistics', 'marketing']).toContain(service.category)
    expect(service.name).not.toBe('')
    expect(service.vendor).not.toBe('')
    expect(service.description_sv).not.toBe('')
    expect(service.match.length).toBeGreaterThan(0)
  }
})

test('no match pattern is a bare google.com, www.google.com, googleapis.com, gstatic.com or facebook.com', () => {
  const bare = ['google.com', 'www.google.com', 'googleapis.com', 'gstatic.com', 'facebook.com']
  for (const service of Object.values(SERVICES)) {
    for (const pattern of service.match) expect(bare).not.toContain(pattern)
  }
})

test('isCategory is true for the four categories and false for service slugs', () => {
  for (const category of CATEGORIES) expect(isCategory(category)).toBe(true)
  for (const slug of Object.keys(SERVICES)) expect(isCategory(slug)).toBe(false)
})

test('matchesRegistry classifies known URLs', () => {
  expect(matchesRegistry('https://www.google.com/maps/embed?pb=1')).toBe('google-maps')
  expect(matchesRegistry('https://maps.google.com/maps?q=x&output=embed')).toBe('google-maps')
  expect(matchesRegistry('https://maps.googleapis.com/maps/api/js?key=x')).toBe('google-maps')
  expect(matchesRegistry('https://www.googletagmanager.com/gtag/js?id=G-1')).toBe('google-analytics')
  expect(matchesRegistry('https://googleads.g.doubleclick.net/pagead/x')).toBe('google-ads')
  expect(matchesRegistry('https://connect.facebook.net/en_US/fbevents.js')).toBe('meta-pixel')
  expect(matchesRegistry('https://www.facebook.com/tr?id=1')).toBe('meta-pixel')
  expect(matchesRegistry('https://calendar.google.com/calendar/embed?src=x&ctz=Europe%2FStockholm')).toBe('google-calendar')
  expect(matchesRegistry('https://elfsightcdn.com/platform.js')).toBe('elfsight')
  expect(matchesRegistry('https://core.service.elfsight.com/p/boot/?w=abc')).toBe('elfsight')
  expect(matchesRegistry('https://apps.elfsight.com/p/platform.js')).toBe('elfsight')
})

test('matchesRegistry leaves Instagram and Facebook image hosts alone', () => {
  expect(matchesRegistry('https://scontent.cdninstagram.com/v/t51/x.jpg')).toBeNull()
  expect(matchesRegistry('https://scontent-arn2-1.xx.fbcdn.net/v/t51/x.jpg')).toBeNull()
})

test('matchesRegistry ignores fonts, recaptcha, umami, plain facebook links and first-party', () => {
  const urls = [
    'https://fonts.googleapis.com/css2?family=Inter',
    'https://www.google.com/recaptcha/api.js',
    'https://www.gstatic.com/recaptcha/releases/x.js',
    'https://analytics.visionmedia.io/script.js',
    'https://www.facebook.com/visionmedia',
    'https://kund.se/kontakt',
  ]
  for (const url of urls) expect(matchesRegistry(url)).toBeNull()
})

test('services.json on disk equals the generated output', () => {
  const onDisk = JSON.parse(readFileSync(new URL('../../services.json', import.meta.url), 'utf8'))
  expect(onDisk).toEqual(generateServicesJson())
})
