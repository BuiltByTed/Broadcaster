const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-database-'))
process.env.CACHE_DIR = cacheDir

const Database = require('../Utilities/Database.js')
const { migrateExistingVideos, backfillDurations } = require('../Utilities/MigrateDatabase.js')
const HLS_CACHE_VERSION = require('../Utilities/HlsCacheVersion.js')
const db = Database()

test.after(() => {
    db.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
})

test('transcode status updates stay scoped to a video row', () => {
    const sharedPath = '/media/shared.mp4'
    const sharedHash = 'shared-hash'
    const firstChannelId = db.upsertChannel('first', 'First', 'movies')
    const secondChannelId = db.upsertChannel('second', 'Second', 'movies')

    db.insertVideo(firstChannelId, sharedPath, sharedHash, 'Shared')
    db.insertVideo(secondChannelId, sharedPath, sharedHash, 'Shared')

    const firstVideo = db.getVideoByPath('first', sharedPath)
    const secondVideo = db.getVideoByPath('second', sharedPath)

    const transcodeResult = db.markVideoTranscoded(
        firstVideo.id,
        120.5,
        13,
        'h264',
        'aac',
        1920,
        1080
    )

    assert.equal(transcodeResult.changes, 1)
    assert.equal(db.getVideoByPath('first', sharedPath).transcoded, 1)
    assert.equal(db.getVideoByPath('second', sharedPath).transcoded, 0)

    db.markVideoTranscoded(secondVideo.id, 90, 10, 'h264', 'aac', 1280, 720)
    const resetResult = db.markVideoNotTranscoded(firstVideo.id)

    assert.equal(resetResult.changes, 1)
    assert.equal(db.getVideoByPath('first', sharedPath).transcoded, 0)
    assert.equal(db.getVideoByPath('second', sharedPath).transcoded, 1)
})

test('migration marks only the channel-specific video row', () => {
    const sharedPath = '/media/migration-shared.mp4'
    const sharedHash = 'migration-shared-hash'
    const firstChannelId = db.upsertChannel('migration-first', 'Migration First', 'movies')
    const secondChannelId = db.upsertChannel('migration-second', 'Migration Second', 'movies')

    db.insertVideo(firstChannelId, sharedPath, sharedHash, 'Migration Shared')
    db.insertVideo(secondChannelId, sharedPath, sharedHash, 'Migration Shared')

    const videoDir = path.join(
        cacheDir,
        'channels',
        'migration-first',
        'videos',
        sharedHash
    )
    fs.mkdirSync(videoDir, { recursive: true })
    fs.writeFileSync(
        path.join(videoDir, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:4.5,\nsegment_00000.ts\n#EXTINF:5.5,\nsegment_00001.ts\n#EXT-X-ENDLIST\n'
    )
    fs.writeFileSync(path.join(videoDir, 'metadata.json'), '{}')

    assert.equal(migrateExistingVideos('migration-first'), 1)

    const firstVideo = db.getVideoByPath('migration-first', sharedPath)
    const secondVideo = db.getVideoByPath('migration-second', sharedPath)

    assert.equal(firstVideo.transcoded, 1)
    assert.equal(firstVideo.duration_seconds, 10)
    assert.equal(firstVideo.segment_count, 2)
    assert.equal(secondVideo.transcoded, 0)
})

test('migration and backfill support versioned v3 cache directories', () => {
    const v3Path = '/media/v3-only.mp4'
    const v3Hash = 'v3-only-hash'
    const channelId = db.upsertChannel('v3-channel', 'V3 Channel', 'shuffle')
    db.insertVideo(channelId, v3Path, v3Hash, 'V3 Only')

    const v3Dir = path.join(
        cacheDir,
        'channels',
        'v3-channel',
        'videos',
        v3Hash,
        `v${HLS_CACHE_VERSION}`
    )
    fs.mkdirSync(v3Dir, { recursive: true })
    fs.writeFileSync(
        path.join(v3Dir, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:1.0,\n#EXT-X-BYTERANGE:100@0\nstream.ts\n#EXTINF:1.5,\n#EXT-X-BYTERANGE:150@100\nstream.ts\n#EXT-X-ENDLIST\n'
    )
    fs.writeFileSync(
        path.join(v3Dir, 'metadata.json'),
        JSON.stringify({ cacheVersion: HLS_CACHE_VERSION })
    )

    assert.equal(migrateExistingVideos('v3-channel'), 1)

    const migrated = db.getVideoByPath('v3-channel', v3Path)
    assert.equal(migrated.transcoded, 1)
    assert.equal(migrated.cache_version, HLS_CACHE_VERSION)
    assert.equal(migrated.duration_seconds, 2.5)
    assert.equal(migrated.segment_count, 2)
    assert.equal(migrated.max_segment_duration, 1.5)

    // Clear duration to verify backfillDurations finds v3 playlist
    db.db.prepare('UPDATE videos SET duration_seconds = NULL, segment_count = NULL WHERE id = ?').run(migrated.id)
    assert.equal(backfillDurations(), 1)
    const backfilled = db.getVideoByPath('v3-channel', v3Path)
    assert.equal(backfilled.duration_seconds, 2.5)
    assert.equal(backfilled.segment_count, 2)
})

test('closing the database resets singleton so subsequent Database() calls reopen cleanly', () => {
    db.close()
    const reopened = Database()
    assert.ok(reopened.db)
    assert.ok(Array.isArray(reopened.getAllChannels()))
    Database.closeIfOpen()
})
