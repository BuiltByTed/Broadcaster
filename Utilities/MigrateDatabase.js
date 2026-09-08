const Database = require('./Database.js')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('./Log.js')
const tag = 'Migration'

const { CACHE_DIR } = process.env

/**
 * Migrate existing transcoded videos to the database
 * Scans the cache directory and marks videos as transcoded if HLS files exist
 */
function migrateExistingVideos(channelSlug) {
    const db = Database()
    const channel = db.getChannelBySlug(channelSlug)

    if (!channel) {
        Log(tag, `Channel ${channelSlug} not found in database`)
        return
    }

    const videos = db.getChannelVideos(channelSlug, false)
    let migratedCount = 0

    videos.forEach(video => {
        const videoDir = path.join(CACHE_DIR, 'channels', channelSlug, 'videos', video.hash)
        // Keep quarantine durable even if shutdown interrupted its DB update.
        if (fs.existsSync(path.join(videoDir, 'invalid-cache.json'))) {
            if (video.transcoded) db.markVideoNotTranscoded(video.id)
            return
        }
        if (video.transcoded) return

        const playlistPath = path.join(videoDir, 'index.m3u8')
        const metadataPath = path.join(videoDir, 'metadata.json')

        // Check if video is fully transcoded
        if (fs.existsSync(playlistPath) && fs.existsSync(metadataPath)) {
            try {
                const playlistContent = fs.readFileSync(playlistPath, 'utf8')

                // Must have ENDLIST marker to be considered complete
                if (playlistContent.includes('#EXT-X-ENDLIST')) {
                    // Calculate duration from playlist
                    let duration = 0
                    let segmentCount = 0
                    playlistContent.split('\n').forEach(line => {
                        if (line.startsWith('#EXTINF:')) {
                            const match = line.match(/#EXTINF:([\d.]+)/)
                            if (match) duration += parseFloat(match[1])
                            segmentCount++
                        }
                    })

                    // Read metadata if available
                    let videoCodec = null
                    let audioCodec = null
                    let width = null
                    let height = null

                    try {
                        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
                        // Metadata might not have codec info, that's okay
                    } catch (e) {
                        // Ignore metadata read errors
                    }

                    // Mark as transcoded
                    db.markVideoTranscoded(video.id, duration, segmentCount, videoCodec, audioCodec, width, height)
                    migratedCount++
                }
            } catch (err) {
                Log(tag, `Error migrating ${video.filename}: ${err.message}`)
            }
        }
    })

    Log(tag, `Migrated ${migratedCount} existing transcoded videos for channel ${channelSlug}`)
    return migratedCount
}

/**
 * Migrate all channels
 */
function migrateAll() {
    const db = Database()
    const channels = db.getAllChannels()

    Log(tag, `Starting migration for ${channels.length} channels...`)

    let totalMigrated = 0
    channels.forEach(channel => {
        const count = migrateExistingVideos(channel.slug)
        totalMigrated += count
    })

    Log(tag, `Migration complete! ${totalMigrated} videos marked as transcoded`)
}

/**
 * Backfill missing durations and segment counts for already-transcoded videos
 * This reads the m3u8 files to get accurate data
 */
function backfillDurations() {
    const db = Database()

    // Find all transcoded videos with NULL duration OR NULL segment_count
    const videos = db.db.prepare(`
        SELECT v.*, c.slug as channel_slug
        FROM videos v
        JOIN channels c ON v.channel_id = c.id
        WHERE v.transcoded = 1 AND (v.duration_seconds IS NULL OR v.segment_count IS NULL)
    `).all()

    if (videos.length === 0) {
        Log(tag, 'No videos need duration/segment backfill')
        return 0
    }

    Log(tag, `Backfilling durations/segments for ${videos.length} videos...`)

    let updated = 0
    videos.forEach(video => {
        const videoDir = path.join(CACHE_DIR, 'channels', video.channel_slug, 'videos', video.hash)
        const playlistPath = path.join(videoDir, 'index.m3u8')

        if (!fs.existsSync(playlistPath)) {
            Log(tag, `Playlist not found for ${video.filename}, skipping`)
            return
        }

        try {
            const playlistContent = fs.readFileSync(playlistPath, 'utf8')
            let duration = 0
            let segmentCount = 0

            playlistContent.split('\n').forEach(line => {
                if (line.startsWith('#EXTINF:')) {
                    const match = line.match(/#EXTINF:([\d.]+)/)
                    if (match) duration += parseFloat(match[1])
                    segmentCount++
                }
            })

            if (duration > 0 && segmentCount > 0) {
                db.db.prepare('UPDATE videos SET duration_seconds = ?, segment_count = ? WHERE id = ?').run(duration, segmentCount, video.id)
                updated++
            }
        } catch (err) {
            Log(tag, `Error reading playlist for ${video.filename}: ${err.message}`)
        }
    })

    Log(tag, `Backfilled durations/segments for ${updated} videos`)
    return updated
}

module.exports = {
    migrateExistingVideos,
    migrateAll,
    backfillDurations
}
