const test = require('node:test')
const assert = require('node:assert/strict')
const { explicitFraming, cropFor, cropConsensus } = require('../Utilities/MediaPresentation.js')

test('TNG and early Frasier have explicit rules without cropping later seasons or the revival', () => {
  assert.equal(explicitFraming('/media/Star Trek - The Next Generation {tvdb-71470}/Season 07/a.mkv'), '4:3')
  for (const season of [1, 8]) assert.equal(explicitFraming(`/media/Frasier (1993) {tvdb-77811}/Season ${season}/a.mkv`), '4:3')
  for (const season of [9, 10, 11]) assert.equal(explicitFraming(`/media/Frasier (1993) {tvdb-77811}/Season ${season}/a.mkv`), '16:9')
  assert.equal(explicitFraming('/media/Frasier (2023)/Season 1/a.mkv'), null)
})

test('crop geometry removes 16:9 side bars, preserves vertical pixels and respects anamorphic sources', () => {
  assert.deepEqual(cropFor({ width: 1920, height: 1080 }), { width: 1440, height: 1080, x: 240, y: 0, sourceWidth: 1920 })
  assert.equal(cropFor({ width: 640, height: 480 }), null)
  assert.equal(cropFor({ width: 720, height: 480, sample_aspect_ratio: '8:9' }), null)
  assert.equal(cropFor({ width: 1920, height: 800 }), null)
  const anamorphic = cropFor({ width: 720, height: 480, sample_aspect_ratio: '32:27' })
  assert.equal(anamorphic.width, 540)
})

test('automatic cropping requires multiple source positions and rejects widescreen or letterbox-only frames', () => {
  const pillar = 'crop=240:180:40:0\ncrop=240:180:40:0'
  assert.equal(cropConsensus([pillar, pillar, pillar, pillar], 16 / 9), true)
  assert.equal(cropConsensus([pillar, pillar], 16 / 9), false)
  assert.equal(cropConsensus([pillar, pillar, pillar, 'crop=320:134:0:24'], 16 / 9), false)
  assert.equal(cropConsensus(['crop=160:90:0:0', pillar, '', ''], 16 / 9), false)
})
