import test from 'node:test'
import assert from 'node:assert/strict'
import { detectPillarbox } from './picture.mjs'
import { parseCaptions, activeCaption } from './captions.mjs'

function frame(left, right, letterbox = false, dark = false) {
  const width = 192, height = 108, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const bright = !dark && x >= left && x < width - right && (!letterbox || (y > 16 && y < 92))
    data.fill(bright ? 180 : 0, (y * width + x) * 4, (y * width + x) * 4 + 3)
  }
  return { data, width, height }
}

test('detects baked-in 4:3 side bars while preserving widescreen letterboxing and dark scenes', () => {
  assert.deepEqual(detectPillarbox(frame(24, 24), 16 / 9), { left: 0.125, right: 0.125 })
  assert.equal(detectPillarbox(frame(0, 0, true), 16 / 9), null)
  assert.equal(detectPillarbox(frame(24, 24, false, true), 16 / 9), null)
  assert.equal(detectPillarbox(frame(24, 24), 4 / 3), null)
  assert.equal(detectPillarbox(frame(5, 40), 16 / 9), null)
})

test('captions preserve lines, remove markup and end on the correct broadcast frame', () => {
  const cues = parseCaptions('WEBVTT\n\n00:01.000 --> 00:03.000 align:center\n<i>Hello &amp; welcome.</i>\nSecond line\n\n00:02.000 --> 00:04.000\n[DOOR OPENS]\n')
  assert.equal(activeCaption(cues, 0.9), '')
  assert.equal(activeCaption(cues, 1.5), 'Hello & welcome.\nSecond line')
  assert.equal(activeCaption(cues, 2.5), 'Hello & welcome.\nSecond line\n[DOOR OPENS]')
  assert.equal(activeCaption(cues, 3), '[DOOR OPENS]')
  assert.equal(activeCaption(cues, 4), '')
})
