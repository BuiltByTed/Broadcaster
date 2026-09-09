import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCaptions, activeCaption } from './captions.mjs'

test('captions preserve lines, remove markup and end on the correct broadcast frame', () => {
  const cues = parseCaptions('WEBVTT\n\n00:01.000 --> 00:03.000 align:center\n<i>Hello &amp; welcome.</i>\nSecond line\n\n00:02.000 --> 00:04.000\n[DOOR OPENS]\n')
  assert.equal(activeCaption(cues, 0.9), '')
  assert.equal(activeCaption(cues, 1.5), 'Hello & welcome.\nSecond line')
  assert.equal(activeCaption(cues, 2.5), 'Hello & welcome.\nSecond line\n[DOOR OPENS]')
  assert.equal(activeCaption(cues, 3), '[DOOR OPENS]')
  assert.equal(activeCaption(cues, 4), '')
})
