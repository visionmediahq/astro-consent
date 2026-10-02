import { expect, test } from 'vitest'
import { deEmbed } from '../../src/embed-url'

test('turns /maps/embed?pb= into /maps?pb=', () => {
  expect(deEmbed('https://www.google.com/maps/embed?pb=!1m18!1m12')).toBe('https://www.google.com/maps?pb=!1m18!1m12')
})

test('drops output=embed and keeps other parameters', () => {
  expect(deEmbed('https://maps.google.com/maps?q=demo&output=embed')).toBe('https://maps.google.com/maps?q=demo')
})

test('drops the query entirely when output=embed was the only parameter', () => {
  expect(deEmbed('https://maps.google.com/maps?output=embed')).toBe('https://maps.google.com/maps')
})

test('leaves a non-embed URL unchanged', () => {
  const url = 'https://www.google.com/maps/search/?api=1&query=demo'
  expect(deEmbed(url)).toBe(url)
  expect(deEmbed('https://example.com/video?output=json')).toBe('https://example.com/video?output=json')
})

test('returns the input when it is not a URL', () => {
  expect(deEmbed('not a url')).toBe('not a url')
})

// Maps Embed API (https://www.google.com/maps/embed/v1/<mode>?key=…): the link must work in a
// normal browser tab and must never carry the site's API key.
test('turns an Embed API place URL into a Maps search link without the API key', () => {
  const link = deEmbed('https://www.google.com/maps/embed/v1/place?key=AIzaSECRET&q=Storgatan+1,+Östersund')
  expect(link).toBe('https://www.google.com/maps/search/?api=1&query=Storgatan+1%2C+%C3%96stersund')
  expect(link).not.toContain('AIzaSECRET')
})

test('turns an Embed API search URL into a Maps search link', () => {
  expect(deEmbed('https://www.google.com/maps/embed/v1/search?key=k&q=pizza+near+Östersund&zoom=12')).toBe(
    'https://www.google.com/maps/search/?api=1&query=pizza+near+%C3%96stersund',
  )
})

test('turns an Embed API place_id URL into a place link', () => {
  expect(deEmbed('https://www.google.com/maps/embed/v1/place?key=k&q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe(
    'https://www.google.com/maps/place/?q=place_id%3AChIJN1t_tDeuEmsRUsoyG83frY4',
  )
})

test('turns an Embed API view URL into a map link centred on the same point', () => {
  expect(deEmbed('https://www.google.com/maps/embed/v1/view?key=k&center=63.1792,14.6357&zoom=14')).toBe(
    'https://www.google.com/maps/@?api=1&map_action=map&center=63.1792%2C14.6357&zoom=14',
  )
})

test('turns an Embed API directions URL into a directions link', () => {
  expect(deEmbed('https://www.google.com/maps/embed/v1/directions?key=k&origin=Östersund&destination=Åre')).toBe(
    'https://www.google.com/maps/dir/?api=1&origin=%C3%96stersund&destination=%C3%85re',
  )
})

test('falls back to plain Google Maps for an Embed API URL it cannot translate, still without the key', () => {
  expect(deEmbed('https://www.google.com/maps/embed/v1/streetview?key=AIzaSECRET&location=46.4,10.0')).toBe(
    'https://www.google.com/maps',
  )
  expect(deEmbed('https://www.google.com/maps/embed/v1/place?key=AIzaSECRET')).toBe('https://www.google.com/maps')
})
