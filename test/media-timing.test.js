const test = require('node:test')
const assert = require('node:assert/strict')
const { streamDuration, timingCandidate, confirmTimingRepair } = require('../Utilities/MediaTiming')

test('repairs a stretched video clock only when counted frames match the audio duration', () => {
    const candidate = timingCandidate({ r_frame_rate: '25/1', tags: { DURATION: '08:42:53.560000000' } },
        { tags: { DURATION: '00:41:50.080000000' } })
    assert.equal(candidate.fps, 25)
    assert.deepEqual(confirmTimingRepair(candidate, 62748), { fps: 25, duration: 2509.92 })
    assert.equal(confirmTimingRepair(candidate, 784339), null)
})

test('preserves normal, silent, unknown-rate and deliberately long video timelines', () => {
    assert.equal(streamDuration({ duration: '12.5' }), 12.5)
    assert.equal(timingCandidate({ duration: 12, r_frame_rate: '25/1' }, { duration: 12 }), null)
    assert.equal(timingCandidate({ duration: 100, r_frame_rate: '25/1' }, null), null)
    assert.equal(timingCandidate({ duration: 100, r_frame_rate: '0/0' }, { duration: 8 }), null)
    assert.equal(confirmTimingRepair({ fps: 25, audioDuration: 8 }, 'N/A'), null)
})
