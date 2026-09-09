import test from 'node:test'
import assert from 'node:assert/strict'
import { ChannelWarmup, parseWarmPlaylist, warmLoader } from './channelWarmup.mjs'

const url = 'http://tv.local/one.m3u8'
const playlist = '#EXTM3U\n#EXT-X-START:TIME-OFFSET=2.5,PRECISE=YES\n#EXTINF:2,\n#EXT-X-BYTERANGE:100@0\n/channels/a/stream.ts\n#EXTINF:3,\n#EXT-X-BYTERANGE:200\n/channels/a/stream.ts\n'

test('warmup selects real durations and resolves implicit byte ranges', () => {
  const parsed = parseWarmPlaylist(playlist, url)
  assert.equal(parsed.offset, 2.5)
  assert.deepEqual(parsed.segments.map(s => [s.time, s.duration, s.rangeStart, s.rangeEnd]), [[0, 2, 0, 100], [2, 3, 100, 300]])
  assert.equal(parseWarmPlaylist(playlist.replace('100@0', '100'), url), null)
  assert.equal(parseWarmPlaylist(playlist.replace('/channels/a/stream.ts', 'https://elsewhere.test/a.ts'), url), null)
})

test('warm cache matches hls whole-file and range requests without transferring its own buffer', () => {
  const cache = new ChannelWarmup()
  cache.put({ url }, new Uint8Array([1, 2, 3]).buffer)
  const copy = cache.get({ url, rangeStart: 0, rangeEnd: 0 })
  assert.deepEqual([...new Uint8Array(copy)], [1, 2, 3])
  new Uint8Array(copy)[0] = 9
  assert.equal(new Uint8Array(cache.get({ url }))[0], 1)
  assert.equal(cache.get({ url, rangeStart: 1, rangeEnd: 2 }), null)
})

test('cached live manifests advance to broadcast time and expire', () => {
  const cache = new ChannelWarmup()
  cache.manifests.set(url, { text: playlist, at: Date.now() - 1000 })
  const warm = parseWarmPlaylist(cache.takeManifest(url), url)
  assert.ok(warm.offset >= 3.5 && warm.offset < 3.6)
  assert.equal(cache.takeManifest(url), null)
  cache.manifests.set(url, { text: playlist, at: Date.now() - 3000 })
  assert.equal(cache.takeManifest(url), null)
})

test('a destroyed warm loader cannot complete a channel the viewer has left', async () => {
  class Base { constructor() { this.stats = { loading: {} } } destroy() {} }
  const cache = new ChannelWarmup()
  cache.put({ url }, new Uint8Array([1]).buffer)
  const Loader = warmLoader(Base, cache)
  let called = false
  const loader = new Loader()
  loader.load({ url, responseType: 'arraybuffer' }, {}, { onSuccess: () => { called = true } })
  loader.destroy()
  await Promise.resolve()
  assert.equal(called, false)
})

test('warm cache is bounded and clears on power off', () => {
  const cache = new ChannelWarmup()
  for (let i = 0; i < 60; i++) cache.put({ url: `${url}/${i}` }, new ArrayBuffer(1024 * 1024))
  assert.ok(cache.bytes <= 32 * 1024 * 1024)
  assert.ok(cache.media.size <= 32)
  cache.clear()
  assert.equal(cache.bytes, 0)
})
