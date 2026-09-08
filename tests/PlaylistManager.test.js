const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-playlist-manager-'))
process.env.CACHE_DIR = cacheDir

const { PlaylistManager } = require('../Classes/PlaylistManager.js')

function writeVideoPlaylist(channelSlug, videoHash, durations) {
    const videoDir = path.join(cacheDir, 'channels', channelSlug, 'videos', videoHash)
    fs.mkdirSync(videoDir, { recursive: true })

    const segments = durations.flatMap((duration, index) => [
        `#EXTINF:${duration.toFixed(6)},`,
        `segment_${String(index).padStart(5, '0')}.ts`
    ])

    fs.writeFileSync(
        path.join(videoDir, 'index.m3u8'),
        ['#EXTM3U', '#EXT-X-VERSION:3', ...segments, '#EXT-X-ENDLIST', ''].join('\n')
    )
}

test.after(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
})

test('reads the original EXTINF duration for every segment', () => {
    writeVideoPlaylist('test-channel', 'video-a', [1.92, 0.96, 2.4])

    const manager = new PlaylistManager({ slug: 'test-channel' })
    const segments = manager.getAllSegmentsForVideo('video-a', { segment_count: 3 })

    assert.deepEqual(
        segments.map(segment => segment.duration),
        [1.92, 0.96, 2.4]
    )
})

test('uses cumulative durations for the live segment and target duration', () => {
    const durations = [
        ...Array(10).fill(1),
        10,
        ...Array(19).fill(1)
    ]
    writeVideoPlaylist('test-channel', 'video-b', durations)

    const now = 1_000_000
    const entry = {
        hash: 'video-b',
        startTime: now - 15_000,
        endTime: now + 24_000
    }
    const video = {
        duration_seconds: 39,
        segment_count: durations.length
    }

    const manager = new PlaylistManager({ slug: 'test-channel' })
    manager.getVideoByHash = () => video
    manager.setGuideGenerator({
        findEntryAtTime: () => entry,
        getActiveGuide: () => ({ schedule: [entry] })
    })

    const originalNow = Date.now
    Date.now = () => now

    try {
        const playlist = manager.createRollingPlaylist()

        assert.match(playlist, /#EXT-X-TARGETDURATION:10\n/)
        assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:0\n/)
        assert.match(playlist, /#EXTINF:10\.000000,\nchannels\/test-channel\/videos\/video-b\/segment_00010\.ts/)
    } finally {
        Date.now = originalNow
    }
})

test('keeps the forward segment window full across a video boundary', () => {
    const currentDurations = [1.92, 0.96, 0.96, 0.96]
    const nextDurations = [2.4, ...Array(17).fill(1)]
    writeVideoPlaylist('test-channel', 'video-c', currentDurations)
    writeVideoPlaylist('test-channel', 'video-d', nextDurations)

    const now = 2_000_000
    const currentEntry = {
        hash: 'video-c',
        startTime: now - 2_000,
        endTime: now + 2_800
    }
    const nextEntry = {
        hash: 'video-d',
        startTime: currentEntry.endTime,
        endTime: currentEntry.endTime + 19_400
    }
    const videos = {
        'video-c': {
            duration_seconds: 4.8,
            segment_count: currentDurations.length
        },
        'video-d': {
            duration_seconds: 19.4,
            segment_count: nextDurations.length
        }
    }

    const manager = new PlaylistManager({ slug: 'test-channel' })
    manager.getVideoByHash = hash => videos[hash]
    manager.setGuideGenerator({
        findEntryAtTime: () => currentEntry,
        getActiveGuide: () => ({ schedule: [currentEntry, nextEntry] })
    })

    const originalNow = Date.now
    Date.now = () => now

    try {
        const playlist = manager.createRollingPlaylist()
        const listedSegments = playlist.match(/\.ts$/gm) || []

        assert.equal(listedSegments.length, 22)
        assert.match(playlist, /#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:[^\n]+\n#EXTINF:2\.400000,/)
        assert.match(playlist, /#EXT-X-TARGETDURATION:3\n/)
    } finally {
        Date.now = originalNow
    }
})
