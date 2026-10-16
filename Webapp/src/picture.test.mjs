import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCaptions, activeCaption } from './captions.mjs'
import { watchPicture } from './picture.mjs'

test('captions preserve lines, remove markup and end on the correct broadcast frame', () => {
  const cues = parseCaptions('WEBVTT\n\n00:01.000 --> 00:03.000 align:center\n<i>Hello &amp; welcome.</i>\nSecond line\n\n00:02.000 --> 00:04.000\n{\\an8}[DOOR &quot;OPENS&quot; &amp;lt;NOW&amp;gt;]\n')
  assert.equal(activeCaption(cues, 0.9), '')
  assert.equal(activeCaption(cues, 1.5), 'Hello & welcome.\nSecond line')
  assert.equal(activeCaption(cues, 2.5), 'Hello & welcome.\nSecond line\n[DOOR "OPENS" &lt;NOW&gt;]')
  assert.equal(activeCaption(cues, 3), '[DOOR "OPENS" &lt;NOW&gt;]')
  assert.equal(activeCaption(cues, 4), '')
})

test('watchPicture applies legacy crop for pre-v3 streams and does not retry on 404', async () => {
  const listeners = new Map()
  const video = {
    videoWidth: 640,
    videoHeight: 360,
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) }
  }
  const updates = []
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async (url) => {
    fetchCalls++
    if (url.includes('missinghash')) return { status: 404, ok: false }
    return { status: 200, ok: true, json: async () => ({ aspect: '4:3', crop: true }) }
  }
  try {
    const stop = watchPicture(video, pic => updates.push(pic))
    // v3 stream does not fetch profile; uses decoded video ratio directly
    stop.setProgram({ slug: 'tv', hash: 'v3hash00000000000000000000000000', cacheVersion: 3 })
    assert.equal(fetchCalls, 0)
    assert.deepEqual(updates.at(-1), { aspect: '16:9', crop: 1 })

    // legacy stream fetches profile and applies 4:3 crop
    stop.setProgram({ slug: 'tv', hash: 'legacy00000000000000000000000000', cacheVersion: 0 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fetchCalls, 1)
    assert.equal(updates.at(-1).aspect, '4:3')
    assert.ok(Math.abs(updates.at(-1).crop - (16 / 9) / (4 / 3)) < 0.01)

    // 404 does not schedule a retry
    stop.setProgram({ slug: 'tv', hash: 'missinghash000000000000000000000', cacheVersion: 0 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fetchCalls, 2)
    stop()
    assert.equal(listeners.size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
