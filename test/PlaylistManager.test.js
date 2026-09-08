const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const databasePath = require.resolve('../Utilities/Database.js')
const logPath = require.resolve('../Utilities/Log.js')
const playlistManagerPath = require.resolve('../Classes/PlaylistManager.js')

require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: () => ({})
}
require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: () => {}
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000

function createPlaylistFixture(t, segmentDurationsByVideo) {
    const cacheDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'broadcaster-playlist-sequence-')
    )
    const originalCacheDir = process.env.CACHE_DIR
    const originalPlaylistManagerModule = require.cache[playlistManagerPath]

    process.env.CACHE_DIR = cacheDir
    delete require.cache[playlistManagerPath]
    const { PlaylistManager } = require(playlistManagerPath)
    const videos = {}

    for (const [hash, durations] of Object.entries(segmentDurationsByVideo)) {
        const videoDir = path.join(
            cacheDir,
            'channels',
            'test-channel',
            'videos',
            hash
        )
        const playlist = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            ...durations.flatMap((duration, segmentIndex) => [
                `#EXTINF:${duration.toFixed(6)},`,
                `segment_${String(segmentIndex).padStart(5, '0')}.ts`
            ]),
            '#EXT-X-ENDLIST',
            ''
        ].join('\n')

        fs.mkdirSync(videoDir, { recursive: true })
        fs.writeFileSync(path.join(videoDir, 'index.m3u8'), playlist)
        videos[hash] = {
            duration_seconds: durations.reduce(
                (total, duration) => total + duration,
                0
            ),
            segment_count: durations.length
        }
    }

    t.after(() => {
        delete require.cache[playlistManagerPath]
        if (originalPlaylistManagerModule) {
            require.cache[playlistManagerPath] = originalPlaylistManagerModule
        }
        if (originalCacheDir === undefined) {
            delete process.env.CACHE_DIR
        } else {
            process.env.CACHE_DIR = originalCacheDir
        }
        fs.rmSync(cacheDir, { recursive: true, force: true })
    })

    return { PlaylistManager, videos }
}

function createEntry(hash, startTime, duration, title = hash) {
    return {
        hash,
        title,
        startTime,
        endTime: startTime + (duration * 1000),
        duration
    }
}

function createGuide(dayStart, schedule) {
    return {
        version: 2,
        dayStart,
        dayEnd: dayStart + DAY_IN_MILLISECONDS,
        schedule
    }
}

function createPlaylistManager({
    PlaylistManager,
    activeGuide,
    historicalGuides = [],
    videos
}) {
    const guidesByDay = new Map(
        [activeGuide, ...historicalGuides].map(guide => [guide.dayStart, guide])
    )
    const guideGenerator = {
        getActiveGuide: () => activeGuide,
        loadGuideForDay: dayStart => guidesByDay.get(dayStart) || null,
        findEntryAtTime: time => {
            const activeEntry = activeGuide.schedule.find(
                entry => entry.startTime <= time && entry.endTime > time
            )
            if (activeEntry) {
                return activeEntry
            }

            const previousGuide = guidesByDay.get(
                activeGuide.dayStart - DAY_IN_MILLISECONDS
            )
            return previousGuide
                ? previousGuide.schedule.find(
                    entry => entry.startTime <= time && entry.endTime > time
                ) || null
                : null
        },
        invalidateCache: () => {}
    }
    const manager = new PlaylistManager({ slug: 'test-channel' })
    manager.setGuideGenerator(guideGenerator)
    manager.getVideoByHash = hash => videos[hash] || null
    manager.getAllSegmentsForVideo = (hash, video) => Array.from(
        { length: video.segment_count },
        (_, segmentIndex) => ({
            duration: video.duration_seconds / video.segment_count,
            path: `channels/test-channel/videos/${hash}/segment_${String(segmentIndex).padStart(5, '0')}.ts`,
            segmentIndex,
            videoHash: hash
        })
    )

    return manager
}

function getTagValue(playlist, tag) {
    const match = playlist.match(new RegExp(`^#${tag}:(\\d+)$`, 'm'))
    return match ? Number(match[1]) : null
}

function getSegmentPaths(playlist) {
    return playlist
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
}

test('keeps media and discontinuity sequences continuous at a program transition', (t) => {
    const dayStart = 100 * DAY_IN_MILLISECONDS
    const firstEntry = createEntry('first', dayStart, 10)
    const secondEntry = createEntry('second', firstEntry.endTime, 12)
    const guide = createGuide(dayStart, [firstEntry, secondEntry])
    const fixture = createPlaylistFixture(t, {
        first: [2, 2, 2, 2, 2],
        second: [2, 2, 2, 2, 2, 2]
    })
    const manager = createPlaylistManager({
        PlaylistManager: fixture.PlaylistManager,
        activeGuide: guide,
        videos: fixture.videos
    })

    t.mock.method(Date, 'now', () => firstEntry.startTime + 9000)
    const transitionPlaylist = manager.createRollingPlaylist()
    const transitionPaths = getSegmentPaths(transitionPlaylist)
    const firstSecondSegment = transitionPaths.findIndex(
        segmentPath => segmentPath.includes('/second/')
    )
    const secondEntrySequence = getTagValue(
        transitionPlaylist,
        'EXT-X-MEDIA-SEQUENCE'
    ) + firstSecondSegment

    assert.equal(getTagValue(transitionPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 0)
    assert.equal(
        getTagValue(transitionPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        0
    )
    assert.match(
        transitionPlaylist,
        /segment_00004\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:[^\n]+\n#EXTINF:/
    )

    Date.now.mock.mockImplementation(() => secondEntry.startTime + 1000)
    const nextPlaylist = manager.createRollingPlaylist()

    assert.equal(getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 5)
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        1
    )
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'),
        secondEntrySequence
    )
})

test('emits a discontinuity when consecutive entries repeat the same video', (t) => {
    const dayStart = 200 * DAY_IN_MILLISECONDS
    const firstEntry = createEntry('repeat', dayStart, 10)
    const secondEntry = createEntry('repeat', firstEntry.endTime, 10)
    const guide = createGuide(dayStart, [firstEntry, secondEntry])
    const fixture = createPlaylistFixture(t, {
        repeat: [2, 2, 2, 2, 2]
    })
    const manager = createPlaylistManager({
        PlaylistManager: fixture.PlaylistManager,
        activeGuide: guide,
        videos: fixture.videos
    })

    t.mock.method(Date, 'now', () => firstEntry.startTime + 9000)
    const playlist = manager.createRollingPlaylist()

    assert.equal(
        playlist.match(/^#EXT-X-DISCONTINUITY$/gm)?.length,
        1
    )

    Date.now.mock.mockImplementation(() => secondEntry.startTime + 1000)
    const nextPlaylist = manager.createRollingPlaylist()

    assert.equal(getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 5)
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        1
    )
})

test('carries sequence offsets across daily guide boundaries', (t) => {
    const previousDayStart = 300 * DAY_IN_MILLISECONDS
    const activeDayStart = previousDayStart + DAY_IN_MILLISECONDS
    const earlyEntry = createEntry('early', previousDayStart, 6)
    const crossingEntry = createEntry('crossing', activeDayStart - 4000, 8)
    const nextEntry = createEntry('next', crossingEntry.endTime, 10)
    const previousGuide = createGuide(
        previousDayStart,
        [earlyEntry, crossingEntry]
    )
    const activeGuide = createGuide(activeDayStart, [nextEntry])
    const fixture = createPlaylistFixture(t, {
        early: [2, 2, 2],
        crossing: [2, 2, 2, 2],
        next: [2, 2, 2, 2, 2]
    })
    const manager = createPlaylistManager({
        PlaylistManager: fixture.PlaylistManager,
        activeGuide,
        historicalGuides: [previousGuide],
        videos: fixture.videos
    })

    t.mock.method(Date, 'now', () => crossingEntry.endTime - 1000)
    const transitionPlaylist = manager.createRollingPlaylist()
    const transitionPaths = getSegmentPaths(transitionPlaylist)
    const firstNextSegment = transitionPaths.findIndex(
        segmentPath => segmentPath.includes('/next/')
    )
    const nextEntrySequence = getTagValue(
        transitionPlaylist,
        'EXT-X-MEDIA-SEQUENCE'
    ) + firstNextSegment

    assert.equal(
        getTagValue(transitionPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        1
    )

    Date.now.mock.mockImplementation(() => nextEntry.startTime + 1000)
    const nextPlaylist = manager.createRollingPlaylist()

    assert.equal(getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 7)
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        2
    )
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'),
        nextEntrySequence
    )
})

test('does not double-count a program copied into the next daily guide', t => {
    const dayStart = 500 * DAY_IN_MILLISECONDS
    const early = createEntry('early', dayStart, 6)
    const crossing = createEntry('crossing', dayStart + DAY_IN_MILLISECONDS - 4000, 8)
    const next = createEntry('next', crossing.endTime, 10)
    const previousGuide = createGuide(dayStart, [early, crossing])
    const activeGuide = createGuide(dayStart + DAY_IN_MILLISECONDS, [{ ...crossing }, next])
    const fixture = createPlaylistFixture(t, { early: [2, 2, 2], crossing: [2, 2, 2, 2], next: [2, 2, 2, 2, 2] })
    const manager = createPlaylistManager({ PlaylistManager: fixture.PlaylistManager, activeGuide, historicalGuides: [previousGuide], videos: fixture.videos })
    const before = manager.getEntryTimelinePosition(crossing)
    const after = manager.getEntryTimelinePosition(next)
    assert.equal(before.mediaSequence, 3)
    assert.equal(before.discontinuitySequence, 1)
    assert.equal(after.mediaSequence, 7)
    assert.equal(after.discontinuitySequence, 2)
})

test('uses local calendar days for playlist continuity across daylight saving time', t => {
    const originalTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
    t.after(() => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ })
    for (const [month, day] of [[2, 9], [10, 2]]) {
        const start = new Date(2025, month, day, 3).getTime()
        const prevStart = new Date(2025, month, day - 1, 3).getTime()
        const prev = createEntry('first', start - 4000, 4)
        const next = createEntry('next', start, 8)
        const previousGuide = createGuide(prevStart, [prev])
        const activeGuide = createGuide(start, [next])
        const fixture = createPlaylistFixture(t, { first: [2, 2], next: [2, 2, 2, 2] })
        const manager = createPlaylistManager({ PlaylistManager: fixture.PlaylistManager, activeGuide, historicalGuides: [previousGuide], videos: fixture.videos })
        assert.equal(manager.getEntryTimelinePosition(next).mediaSequence, 2)
        assert.equal(manager.getEntryTimelinePosition(next).discontinuitySequence, 1)
    }
})

test('playlists carry wall-clock start hints, fixed target duration and immutable cached segments', t => {
    const dayStart = 600 * DAY_IN_MILLISECONDS
    const first = createEntry('first', dayStart, 8)
    const next = createEntry('next', first.endTime, 8)
    const guide = createGuide(dayStart, [first, next])
    const fixture = createPlaylistFixture(t, { first: [2, 2, 2, 2], next: [2, 2, 2, 2] })
    const manager = createPlaylistManager({ PlaylistManager: fixture.PlaylistManager, activeGuide: guide, videos: fixture.videos })
    manager.getAllSegmentsForVideo = fixture.PlaylistManager.prototype.getAllSegmentsForVideo
    manager.targetDuration = 10
    t.mock.method(Date, 'now', () => first.startTime + 7000)
    const a = manager.createRollingPlaylist()
    assert.match(a, /#EXT-X-START:TIME-OFFSET=7\.000,PRECISE=YES/)
    assert.match(a, /#EXT-X-PROGRAM-DATE-TIME:/)
    assert.equal(getTagValue(a, 'EXT-X-TARGETDURATION'), 10)
    assert.equal(manager.getAllSegmentsForVideo('next', fixture.videos.next)[0].startsDiscontinuity, undefined)
    Date.now.mock.mockImplementation(() => next.startTime + 1000)
    const b = manager.createRollingPlaylist()
    assert.equal(getTagValue(b, 'EXT-X-TARGETDURATION'), 10)
    assert.doesNotMatch(b, /^#EXT-X-DISCONTINUITY$/m)
})
