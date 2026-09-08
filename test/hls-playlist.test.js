const test = require('node:test')
const assert = require('node:assert/strict')
const { parseHlsPlaylist } = require('../Utilities/HlsPlaylist.js')
test('retains encoder filenames, fractional durations and cumulative offsets', () => {
  const parsed = parseHlsPlaylist('#EXTM3U\r\n#EXTINF:1.001,\r\nsegment_00009.ts\r\n#EXTINF:0.5,\r\nsegment_00010.ts\r\n#EXT-X-ENDLIST\r\n')
  assert.equal(parsed.segments[1].offset, 1.001)
  assert.equal(parsed.segments[0].uri, 'segment_00009.ts')
  assert.equal(parsed.duration, 1.501)
  assert.equal(parsed.maxDuration, 1.001)
  assert.equal(parsed.complete, true)
})
test('rejects invalid durations, incomplete segments and unsafe URIs', () => {
  for (const body of ['#EXTINF:NaN,\nsegment_00000.ts', '#EXTINF:0,\nsegment_00000.ts',
    '#EXTINF:2,\n../secret.ts', '#EXTINF:2,', '#EXTM3U\n#EXT-X-ENDLIST']) {
    assert.throws(() => parseHlsPlaylist(body))
  }
})

test('normalizes byte ranges so sliding playlists can always use explicit offsets', () => {
  const parsed = parseHlsPlaylist('#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:1880@0\nstream.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:3760\nstream.ts\n#EXT-X-ENDLIST')
  assert.deepEqual(parsed.segments.map(segment => segment.byteRange), [{ length: 1880, start: 0 }, { length: 3760, start: 1880 }])
  assert.throws(() => parseHlsPlaylist('#EXTINF:1,\n#EXT-X-BYTERANGE:100\nstream.ts'))
  assert.throws(() => parseHlsPlaylist('#EXTINF:1,\n#EXT-X-BYTERANGE:0@0\nstream.ts'))
})
