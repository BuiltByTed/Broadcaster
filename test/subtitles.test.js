const test = require('node:test')
const assert = require('node:assert/strict')
const { subtitleRank, mapPlexPath } = require('../Utilities/Subtitles.js')

test('Plex path mapping respects directory boundaries and prefers specific mounts', () => {
  const mappings = [{ to: '/media', from: '/all' }, { to: '/media/TV', from: '/tv' }]
  assert.equal(mapPlexPath('/media/TV/Show/file.mkv', mappings), '/tv/Show/file.mkv')
  assert.equal(mapPlexPath('/media/TVExtra/file.mkv', mappings), '/all/TVExtra/file.mkv')
  assert.equal(mapPlexPath('/media2/file.mkv', mappings), null)
})

test('full English captions outrank forced-only and foreign subtitle tracks', () => {
  assert.ok(subtitleRank({ languageCode: 'eng' }) > subtitleRank({ languageCode: 'eng', forced: true }))
  assert.ok(subtitleRank({ languageCode: 'fre', default: true }) < 0)
  assert.ok(subtitleRank({ tags: { language: 'eng' }, disposition: { default: 1 } }) > subtitleRank({ tags: { language: 'und' } }))
})
