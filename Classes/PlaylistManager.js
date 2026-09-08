const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const { parseHlsPlaylist } = require('../Utilities/HlsPlaylist.js')
const tag = 'PlaylistManager'
function adjacentDay(time, offset) { const date = new Date(time); date.setDate(date.getDate() + offset); return date.getTime() }
const { CACHE_DIR, HLS_SEGMENT_LENGTH_SECONDS } = process.env
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000

class PlaylistManager {

    constructor(channel) {
        this.channel = channel
        // GuideGenerator is set by Channel after construction
        this.guideGenerator = null
        this.guideTimelineCache = new Map()
        this.segmentCountCache = new Map()
        this.segmentCache = new Map()
        this.timelinePositions = new WeakMap()
    }

    /**
     * Set the guide generator reference
     */
    setGuideGenerator(guideGenerator) {
        this.guideGenerator = guideGenerator
    }

    /**
     * Find an entry in a guide by its stable schedule identity
     */
    getEntryIndex(guide, entry) {
        if (!guide || !Array.isArray(guide.schedule)) {
            return -1
        }

        return guide.schedule.findIndex(
            candidate => candidate.hash === entry.hash && candidate.startTime === entry.startTime
        )
    }

    /**
     * Find the guide that owns an entry. Around the 3am boundary the active
     * entry can still belong to the previous day's guide.
     */
    getGuideContainingEntry(entry) {
        const activeGuide = this.guideGenerator.getActiveGuide()
        if (this.getEntryIndex(activeGuide, entry) >= 0) {
            return activeGuide
        }

        if (
            activeGuide
            && Number.isFinite(activeGuide.dayStart)
            && typeof this.guideGenerator.loadGuideForDay === 'function'
        ) {
            const previousGuide = this.guideGenerator.loadGuideForDay(
                adjacentDay(activeGuide.dayStart, -1)
            )
            if (this.getEntryIndex(previousGuide, entry) >= 0) {
                return previousGuide
            }
            const nextGuide = this.guideGenerator.loadGuideForDay(adjacentDay(activeGuide.dayStart, 1))
            if (this.getEntryIndex(nextGuide, entry) >= 0) return nextGuide
        }

        return null
    }

    /**
     * Use exact transcoded segment counts when available. Historical guide
     * entries can outlive their database rows, so retain a duration fallback.
     */
    getSegmentCountForEntry(entry) {
        if (entry.segmentCount > 0) return entry.segmentCount
        const key = `${entry.hash}:${entry.cacheVersion || 0}`
        if (this.segmentCountCache.has(key)) return this.segmentCountCache.get(key)
        const video = this.getVideoByHash(entry.hash)
        if (video) {
            const segments = this.getAllSegmentsForVideo(entry.hash, video, entry.cacheVersion || 0)
            if (segments.length) {
                this.segmentCountCache.set(key, segments.length)
                return segments.length
            }
            if (video.segment_count > 0) return video.segment_count
        }
        return Math.ceil((entry.duration || (entry.endTime - entry.startTime) / 1000) / (Number(HLS_SEGMENT_LENGTH_SECONDS) || 2))
    }

    /**
     * Calculate the channel-wide sequence offsets at the start of a guide.
     * Daily guides are persisted, so walking backward once gives stable,
     * exact offsets that survive program and day boundaries.
     */
    getGuideTimelineStart(guide) {
        if (guide.timelineStart) return guide.timelineStart
        if (this.guideTimelineCache.has(guide)) return this.guideTimelineCache.get(guide)
        // Legacy guides have no sequence checkpoint. Anchor once at upgrade,
        // rather than reopening months of playlists in a channel-switch request.
        if (guide.channelSlug) {
            const previous = this.guideGenerator.loadGuideForDay?.(adjacentDay(guide.dayStart, -1))
            if (!previous?.timelineStart) {
                guide.timelineStart = { mediaSequence: Math.floor((guide.schedule[0]?.startTime || guide.dayStart) / 1000), discontinuitySequence: Math.floor(guide.dayStart / 1000) }
                this.guideGenerator.saveGuide?.(guide)
                return guide.timelineStart
            }
        }
        const pending = []
        const visited = new Set()
        let cursor = guide
        while (cursor && !cursor.timelineStart && !this.guideTimelineCache.has(cursor)) {
            if (visited.has(cursor.dayStart) || pending.length >= 32) break
            pending.push(cursor)
            visited.add(cursor.dayStart)
            cursor = Number.isFinite(cursor.dayStart) && this.guideGenerator.loadGuideForDay
                ? this.guideGenerator.loadGuideForDay(adjacentDay(cursor.dayStart, -1)) : null
        }
        let previous = cursor
        let base = cursor?.timelineStart || this.guideTimelineCache.get(cursor) || { mediaSequence: 0, discontinuitySequence: 0 }
        for (const current of pending.reverse()) {
            if (previous) {
                // The first program may be a copy of yesterday's last program.
                // Count it once, preserving the identity on both sides of 3am.
                const first = current.schedule?.[0]
                const overlapIndex = first ? this.getEntryIndex(previous, first) : -1
                const preceding = overlapIndex >= 0 ? previous.schedule.slice(0, overlapIndex) : (previous.schedule || [])
                base = {
                    mediaSequence: base.mediaSequence + preceding.reduce((sum, entry) => sum + this.getSegmentCountForEntry(entry), 0),
                    discontinuitySequence: base.discontinuitySequence + preceding.length
                }
            }
            this.guideTimelineCache.set(current, base)
            if (Number.isFinite(current.dayStart) && this.guideGenerator.saveGuide) {
                current.timelineStart = base
                this.guideGenerator.saveGuide(current)
            }
            previous = current
        }
        while (this.guideTimelineCache.size > 8) this.guideTimelineCache.delete(this.guideTimelineCache.keys().next().value)
        return guide.timelineStart || this.guideTimelineCache.get(guide) || base
    }

    /**
     * Resolve the sequence numbers assigned to the first segment of an entry.
     */
    getEntryTimelinePosition(entry) {
        const guide = this.getGuideContainingEntry(entry)
        const entryIndex = this.getEntryIndex(guide, entry)

        if (!guide || entryIndex < 0) {
            const segmentLength = parseFloat(HLS_SEGMENT_LENGTH_SECONDS) || 2
            return {
                mediaSequence: Math.floor(entry.startTime / (segmentLength * 1000)),
                discontinuitySequence: 0,
                guide: null,
                entryIndex: -1
            }
        }

        const guideStart = this.getGuideTimelineStart(guide)
        if (!this.timelinePositions.has(guide)) {
            let count = 0
            this.timelinePositions.set(guide, guide.schedule.map(entry => {
                const offset = count
                count += this.getSegmentCountForEntry(entry)
                return offset
            }))
        }
        const precedingSegmentCount = this.timelinePositions.get(guide)[entryIndex]

        return {
            mediaSequence: guideStart.mediaSequence + precedingSegmentCount,
            discontinuitySequence: guideStart.discontinuitySequence + entryIndex,
            guide: guide,
            entryIndex: entryIndex
        }
    }

    /**
     * Find the next scheduled entry, including a daily guide boundary.
     */
    getNextEntry(timelinePosition) {
        const { guide, entryIndex } = timelinePosition
        if (!guide || entryIndex < 0) {
            return null
        }

        if (entryIndex < guide.schedule.length - 1) {
            return guide.schedule[entryIndex + 1]
        }

        if (
            !Number.isFinite(guide.dayStart)
            || typeof this.guideGenerator.loadGuideForDay !== 'function'
        ) {
            return null
        }

        const nextDayStart = adjacentDay(guide.dayStart, 1)
        const activeGuide = this.guideGenerator.getActiveGuide()
        const nextGuide = activeGuide && activeGuide.dayStart === nextDayStart
            ? activeGuide
            : (this.guideGenerator.getGuideForDay ? this.guideGenerator.getGuideForDay(nextDayStart) : this.guideGenerator.loadGuideForDay(nextDayStart))

        return nextGuide && Array.isArray(nextGuide.schedule)
            ? nextGuide.schedule.find(entry => entry.startTime >= guide.schedule[entryIndex].endTime - 1) || null
            : null
    }

    /**
     * Generate a unique hash for a video file path
     */
    getVideoHash(filePath) {
        return crypto.createHash('md5').update(filePath).digest('hex')
    }

    /**
     * Get video metadata from database by hash
     */
    getVideoByHash(hash) {
        const db = Database()
        return db.getVideoByHash(this.channel.slug, hash)
    }

    /**
     * Generate all segments for a video
     */
    getAllSegmentsForVideo(videoHash, video, cacheVersion = 0) {
        if (!video) return []
        const key = `${videoHash}:${cacheVersion}`
        if (this.segmentCache.has(key)) return this.segmentCache.get(key)
        const relativeDir = `channels/${this.channel.slug}/videos/${videoHash}${cacheVersion ? `/v${cacheVersion}` : ''}`
        try {
            const parsed = parseHlsPlaylist(fs.readFileSync(path.join(CACHE_DIR, relativeDir, 'index.m3u8'), 'utf8'))
            const segments = parsed.segments.map((segment, segmentIndex) => ({
                duration: segment.duration, offset: segment.offset, byteRange: segment.byteRange,
                path: `${relativeDir}/${segment.uri}`, segmentIndex, videoHash
            }))
            this.segmentCache.set(key, segments)
            while (this.segmentCache.size > 12) this.segmentCache.delete(this.segmentCache.keys().next().value)
            return segments
        } catch (error) {
            Log(tag, `Could not read segments for ${videoHash}: ${error.message}`, this.channel)
            return []
        }
    }

    /**
     * Find the segment containing an offset using the playlist's cumulative durations
     */
    getSegmentIndexForOffset(segments, offsetSeconds) {
        let segmentEnd = 0

        for (let i = 0; i < segments.length; i++) {
            segmentEnd += segments[i].duration
            if (offsetSeconds < segmentEnd) {
                return i
            }
        }

        return Math.max(segments.length - 1, 0)
    }

    /**
     * Create a rolling playlist based on what the guide says should be playing now
     * This is the core method that serves HLS playlists to clients
     *
     * Strategy: Include all segments from start of video up to current position + buffer.
     * This gives players enough context to sync properly.
     */
    createRollingPlaylist() {
        if (!this.guideGenerator) return this.getEmptyPlaylist()
        const now = Date.now()
        const entry = this.guideGenerator.findEntryAtTime(now)
        if (!entry) return this.getEmptyPlaylist()
        const video = this.getVideoByHash(entry.hash)
        const current = this.getAllSegmentsForVideo(entry.hash, video, entry.cacheVersion || 0)
        if (!current.length) return this.getEmptyPlaylist()
        const position = this.getEntryTimelinePosition(entry)
        const offset = (now - entry.startTime) / 1000
        // Real-time window instead of 18 potentially ten-second-long segments.
        const startIndex = this.getSegmentIndexForOffset(current, Math.max(0, offset - 40))
        const segments = []
        let cursorEntry = entry
        let cursorSegments = current
        let index = startIndex
        let segmentTime = entry.startTime + current.slice(0, startIndex).reduce((sum, segment) => sum + segment.duration * 1000, 0)
        const startTime = segmentTime
        const ahead = Math.max(30, 3 * (this.targetDuration || 2))
        for (let programs = 0; programs < 100; programs++) {
            while (index < cursorSegments.length && segmentTime < now + ahead * 1000) {
                const segment = cursorSegments[index]
                segments.push({ ...segment, programTime: segmentTime, discontinuity: segments.length > 0 && index === 0 })
                segmentTime += segment.duration * 1000
                index++
            }
            if (segmentTime >= now + ahead * 1000) break
            const next = this.getNextEntry(this.getEntryTimelinePosition(cursorEntry))
            if (!next || Math.abs(next.startTime - cursorEntry.endTime) > 1) break
            cursorEntry = next
            cursorSegments = this.getAllSegmentsForVideo(next.hash, this.getVideoByHash(next.hash), next.cacheVersion || 0)
            if (!cursorSegments.length) break
            index = 0
            segmentTime = next.startTime
        }
        if (!segments.length) return this.getEmptyPlaylist()
        const target = this.targetDuration || Math.ceil(segments.reduce((max, segment) => Math.max(max, segment.duration), 2))
        let playlist = '#EXTM3U\n#EXT-X-VERSION:6\n'
        playlist += `#EXT-X-TARGETDURATION:${target}\n`
        playlist += `#EXT-X-MEDIA-SEQUENCE:${position.mediaSequence + startIndex}\n`
        playlist += `#EXT-X-DISCONTINUITY-SEQUENCE:${position.discontinuitySequence}\n`
        playlist += `#EXT-X-START:TIME-OFFSET:${((now - startTime) / 1000).toFixed(3)},PRECISE=YES\n`
        segments.forEach((segment, index) => {
            if (segment.discontinuity) playlist += '#EXT-X-DISCONTINUITY\n'
            if (index === 0 || segment.discontinuity) playlist += `#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.programTime).toISOString()}\n`
            playlist += `#EXTINF:${segment.duration.toFixed(6)},\n`
            if (segment.byteRange) playlist += `#EXT-X-BYTERANGE:${segment.byteRange.length}@${segment.byteRange.start}\n`
            playlist += `${segment.path}\n`
        })
        return playlist
    }

    /**
     * Return an empty/static playlist
     */
    getEmptyPlaylist() {
        return null
    }

    /**
     * Get the manifest path for storing video metadata
     */
    getManifestPath() {
        return path.join(CACHE_DIR, 'channels', this.channel.slug, 'manifest.json')
    }

    /**
     * Load or create the video manifest with original filenames
     */
    loadManifest() {
        const manifestPath = this.getManifestPath()
        try {
            if (fs.existsSync(manifestPath)) {
                return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            }
        } catch (err) {
            Log(tag, `Error loading manifest: ${err.message}`, this.channel, { error: err, manifest_path: manifestPath })
        }
        return {}
    }

    /**
     * Save video metadata to manifest
     */
    saveManifest(manifest) {
        const manifestPath = this.getManifestPath()
        const dir = path.dirname(manifestPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    }

    /**
     * Update manifest with video metadata from database
     */
    updateManifest() {
        const manifest = this.loadManifest()
        const db = Database()
        const videos = db.getChannelVideos(this.channel.slug, false) // all videos

        videos.forEach(video => {
            const videoHash = this.getVideoHash(video.file_path)
            if (!manifest[videoHash]) {
                manifest[videoHash] = {
                    originalPath: video.file_path,
                    filename: path.basename(video.file_path, path.extname(video.file_path)),
                    addedAt: Date.now()
                }
            }
        })

        this.saveManifest(manifest)
        return manifest
    }

    /**
     * Get a friendly display name for a video
     */
    getVideoDisplayName(filePath) {
        if (this.channel.paths) {
            for (const configuredPath of this.channel.paths) {
                if (filePath.startsWith(configuredPath)) {
                    return path.basename(configuredPath)
                }
            }
        }
        return path.basename(path.dirname(filePath))
    }

    /**
     * Get schedule for the TV guide - delegates to GuideGenerator
     */
    getSchedule() {
        if (!this.guideGenerator) {
            return []
        }
        return this.guideGenerator.getScheduleForAPI()
    }

    /**
     * Get the day start for TV guide display
     */
    getDayStart() {
        if (!this.guideGenerator) {
            return Date.now()
        }
        const guide = this.guideGenerator.getActiveGuide()
        return guide ? guide.dayStart : Date.now()
    }

    /**
     * Start the playlist manager
     */
    start() {
        this.updateManifest()
        const stats = Database().getChannelStats(this.channel.slug)
        let maximum = Number(stats?.maxSegmentDuration) || 2
        const guide = this.guideGenerator.getActiveGuide()
        const measured = new Set()
        for (const entry of guide.schedule) {
            const key = `${entry.hash}:${entry.cacheVersion || 0}`
            if (measured.has(key)) continue
            measured.add(key)
            const segments = this.getAllSegmentsForVideo(entry.hash, this.getVideoByHash(entry.hash), entry.cacheVersion || 0)
            for (const segment of segments) maximum = Math.max(maximum, segment.duration)
        }
        this.targetDuration = Math.ceil(maximum)
        Log(tag, 'Playlist manager started', this.channel)
    }

    /**
     * Invalidate cache - now delegates to guide generator
     */
    invalidateCache() {
        this.segmentCache.clear()
        if (this.guideGenerator) {
            this.guideGenerator.invalidateCache()
        }
        this.timelinePositions = new WeakMap()
        this.guideTimelineCache.clear()
        this.segmentCountCache.clear()
    }
}

module.exports = {
    PlaylistManager: PlaylistManager
}
