const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const Log = require('./Log.js')
const tag = 'Database'
const HLS_CACHE_VERSION = require('./HlsCacheVersion.js')

const { CACHE_DIR } = process.env

class DatabaseManager {
    constructor() {
        this.db = null
    }

    /**
     * Initialize the database connection and schema
     */
    initialize() {
        const dbPath = path.join(CACHE_DIR, 'broadcaster.db')
        Log(tag, `Initializing database at ${dbPath}`)

        fs.mkdirSync(path.dirname(dbPath), { recursive: true })
        this.db = new Database(dbPath)
        this.db.pragma('busy_timeout = 5000')
        this.db.pragma('journal_mode = WAL')
        this.db.pragma('foreign_keys = ON')

        this.createTables()
        this.createIndexes()

        Log(tag, 'Database initialized successfully')
    }

    /**
     * Create database tables
     */
    createTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                hash TEXT NOT NULL,
                filename TEXT NOT NULL,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                transcoded BOOLEAN DEFAULT 0,
                transcoded_at DATETIME,
                duration_seconds REAL,
                segment_count INTEGER,
                video_codec TEXT,
                audio_codec TEXT,
                width INTEGER,
                height INTEGER,
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                UNIQUE(channel_id, file_path)
            );
        `)
    }

    /**
     * Create indexes for fast queries
     */
    createIndexes() {
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_videos_channel_transcoded
                ON videos(channel_id, transcoded);
            CREATE INDEX IF NOT EXISTS idx_videos_hash
                ON videos(hash);
            CREATE INDEX IF NOT EXISTS idx_videos_file_path
                ON videos(file_path);
            CREATE INDEX IF NOT EXISTS idx_channels_slug
                ON channels(slug);
        `)

        const columns = this.db.pragma('table_info(videos)')
        if (!columns.some(column => column.name === 'max_segment_duration')) {
            this.db.exec('ALTER TABLE videos ADD COLUMN max_segment_duration REAL')
        }

        if (!columns.some(column => column.name === 'cache_quarantined')) {
            this.db.exec('ALTER TABLE videos ADD COLUMN cache_quarantined INTEGER NOT NULL DEFAULT 0')
        }

        if (!columns.some(column => column.name === 'cache_version')) {
            this.db.exec('ALTER TABLE videos ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0')
        }

        // Add segment_count column if it doesn't exist (migration for existing DBs)
        try {
            this.db.exec(`ALTER TABLE videos ADD COLUMN segment_count INTEGER`)
            Log(tag, 'Added segment_count column to videos table')
        } catch (e) {
            // Column already exists, ignore
        }
    }

    /**
     * Insert or update a channel
     */
    upsertChannel(slug, name, type) {
        const stmt = this.db.prepare(`
            INSERT INTO channels (slug, name, type)
            VALUES (?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
                name = excluded.name,
                type = excluded.type,
                updated_at = CURRENT_TIMESTAMP
        `)
        const result = stmt.run(slug, name, type)

        // Get the channel ID
        const channel = this.db.prepare('SELECT id FROM channels WHERE slug = ?').get(slug)
        return channel.id
    }

    /**
     * Get channel by slug
     */
    getChannelBySlug(slug) {
        return this.db.prepare('SELECT * FROM channels WHERE slug = ?').get(slug)
    }

    /**
     * Insert a video (or ignore if already exists)
     */
    insertVideo(channelId, filePath, hash, filename) {
        const stmt = this.insertVideoStatement ||= this.db.prepare(`
            INSERT OR IGNORE INTO videos
                (channel_id, file_path, hash, filename)
            VALUES (?, ?, ?, ?)
        `)
        return stmt.run(channelId, filePath, hash, filename)
    }

    /**
     * Update video transcoding status
     */
    markVideoTranscoded(videoId, durationSeconds, segmentCount, videoCodec, audioCodec, width, height, cacheVersion = 0) {
        const stmt = this.db.prepare(`
            UPDATE videos SET
                transcoded = 1,
                transcoded_at = CURRENT_TIMESTAMP,
                duration_seconds = ?,
                segment_count = ?,
                video_codec = ?,
                audio_codec = ?,
                width = ?,
                height = ?,
                cache_version = ?,
                cache_quarantined = 0
            WHERE id = ?
        `)
        return stmt.run(durationSeconds, segmentCount, videoCodec, audioCodec, width, height, cacheVersion, videoId)
    }

    quarantineVideo(videoId) {
        return this.db.prepare('UPDATE videos SET transcoded = 0, cache_quarantined = 1 WHERE id = ?').run(videoId)
    }

    updateSegmentMetadata(videoId, parsed) {
        this.db.prepare(`UPDATE videos SET max_segment_duration = ?, duration_seconds = ?, segment_count = ?
            WHERE id = ? AND (max_segment_duration IS NULL OR max_segment_duration != ?
                OR duration_seconds != ? OR segment_count != ?)`).run(
            parsed.maxDuration, parsed.duration, parsed.segments.length, videoId,
            parsed.maxDuration, parsed.duration, parsed.segments.length)
    }

    /**
     * Reset video transcoding status
     */
    markVideoNotTranscoded(videoId) {
        return this.db.prepare(`
            UPDATE videos SET transcoded = 0
            WHERE id = ?
        `).run(videoId)
    }

    /**
     * Get all videos for a channel
     */
    getChannelVideos(channelSlug, transcodedOnly = false) {
        let query = `
            SELECT v.* FROM videos v
            JOIN channels c ON v.channel_id = c.id
            WHERE c.slug = ?
        `
        if (transcodedOnly) {
            query += ' AND v.transcoded = 1 AND v.cache_quarantined = 0'
        }
        query += ' ORDER BY v.id'

        return this.db.prepare(query).all(channelSlug)
    }

    /**
     * Get video by hash
     */
    getVideoByHash(channelSlug, hash) {
        return this.db.prepare(`
            SELECT v.* FROM videos v
            JOIN channels c ON v.channel_id = c.id
            WHERE c.slug = ? AND v.hash = ?
        `).get(channelSlug, hash)
    }

    /**
     * Get video by file path and channel
     */
    getVideoByPath(channelSlug, filePath) {
        return this.db.prepare(`
            SELECT v.* FROM videos v
            JOIN channels c ON v.channel_id = c.id
            WHERE c.slug = ? AND v.file_path = ?
        `).get(channelSlug, filePath)
    }

    /**
     * Get count of transcoded vs total videos for a channel
     */
    getChannelStats(channelSlug) {
        return this.db.prepare(`
            SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN transcoded = 1 AND cache_quarantined = 0 THEN 1 ELSE 0 END), 0) as transcoded,
                MAX(CASE WHEN transcoded = 1 AND cache_quarantined = 0 THEN max_segment_duration ELSE 0 END) as maxSegmentDuration,
                COALESCE(SUM(CASE WHEN cache_version >= ${HLS_CACHE_VERSION} AND transcoded = 1 AND cache_quarantined = 0 THEN 1 ELSE 0 END), 0) as rebuilt
            FROM videos v
            JOIN channels c ON v.channel_id = c.id
            WHERE c.slug = ?
        `).get(channelSlug)
    }

    /**
     * Delete videos that no longer exist in the channel queue
     * Returns array of hashes that were deleted
     */
    deleteRemovedVideos(channelSlug, currentFilePaths) {
        const channel = this.getChannelBySlug(channelSlug)
        if (!channel) return []

        // Get current videos in DB for this channel
        const currentVideos = this.getChannelVideos(channelSlug, false)
        const currentPathSet = new Set(currentFilePaths)

        const deletedHashes = []
        currentVideos.forEach(video => {
            if (!currentPathSet.has(video.file_path)) {
                deletedHashes.push(video.hash)
            }
        })

        if (deletedHashes.length > 0) {
            const stmt = this.db.prepare('DELETE FROM videos WHERE channel_id = ? AND hash = ?')
            this.db.transaction(() => {
                for (const hash of deletedHashes) stmt.run(channel.id, hash)
            })()
        }

        return deletedHashes
    }

    /**
     * Get all channels
     */
    getAllChannels() {
        return this.db.prepare('SELECT * FROM channels ORDER BY name').all()
    }

    /**
     * Close the database connection
     */
    close() {
        if (this.db) {
            this.db.close()
            Log(tag, 'Database connection closed')
        }
    }
}

// Singleton instance
let instance = null

module.exports = () => {
    if (!instance) {
        instance = new DatabaseManager()
        instance.initialize()
    }
    return instance
}
