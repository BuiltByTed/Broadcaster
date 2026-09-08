const { spawn, execSync, execFileSync, execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('./Log.js')
const Database = require('./Database.js')
const { parseHlsPlaylist } = require('./HlsPlaylist.js')
const tag = 'PreGenerator'
const { timingCandidate, confirmTimingRepair } = require('./MediaTiming.js')
const HLS_CACHE_VERSION = 2

const { CACHE_DIR,
        VIDEO_CODEC,
        VIDEO_CRF,
        VIDEO_PRESET,
        VIDEO_FILTER,
        AUDIO_CODEC,
        AUDIO_BITRATE,
        HLS_SEGMENT_LENGTH_SECONDS,
        DIMENSIONS } = process.env

// Check if NVIDIA GPU is available
let hasNvidiaGPU = false
let gpuCheckDone = false

/**
 * VIDEO_FILTER of yadif or yadif_cuda both request deinterlace.
 * CUDA vs CPU filter is chosen from the active encode path, not the env string alone.
 * @param {string|undefined} videoFilter
 * @param {boolean} useCuda
 * @returns {string} filter prefix ending in comma, or empty string
 */
function deinterlacePrefix(videoFilter, useCuda) {
    if (videoFilter !== 'yadif' && videoFilter !== 'yadif_cuda') return ''
    return useCuda ? 'yadif_cuda,' : 'yadif,'
}

/**
 * Probe result from getVideoInfo when ffprobe cannot open the file or finds no video stream.
 * The codec placeholder used to be the literal string "error", which made the Processing log
 * line classify as ERROR in the log shipper.
 * @param {{codec?: string}|null|undefined} videoInfo
 * @returns {boolean}
 */
function isUnreadableProbeResult(videoInfo) {
    if (!videoInfo || typeof videoInfo !== 'object') return true
    if (videoInfo.probeFailed || videoInfo.unreadable) return true
    const codec = videoInfo.codec
    return codec === 'unreadable' || codec === 'error' || codec === '?' || codec === ''
}

/**
 * FFmpeg/ffprobe stderr that indicates bad library media (corrupt, empty, truncated, missing)
 * rather than an encode-path or host problem. These should log at warn and skip the item.
 * Superset of the earlier isInvalidMediaStderr signatures (EBML, moov, Error opening input, etc.).
 * @param {string} stderr
 * @returns {boolean}
 */
function isUnreadableMediaStderr(stderr) {
    if (typeof stderr !== 'string' || stderr.length === 0) return false
    return /Invalid data found when processing input/i.test(stderr) ||
        /Invalid data found/i.test(stderr) ||
        /EBML header parsing failed/i.test(stderr) ||
        /invalid as first byte of an EBML number/i.test(stderr) ||
        /misdetection possible/i.test(stderr) ||
        /Error opening input/i.test(stderr) ||
        /moov atom not found/i.test(stderr) ||
        /End of file/i.test(stderr) ||
        /does not contain any stream/i.test(stderr) ||
        /could not find codec parameters/i.test(stderr) ||
        /Invalid argument/i.test(stderr) && /matroska|webm|mov|mp4|avi|mpeg/i.test(stderr) ||
        /No such file or directory/i.test(stderr) ||
        /Permission denied/i.test(stderr)
}

function checkNvidiaGPU() {
    if (gpuCheckDone) return hasNvidiaGPU

    try {
        // Query the device directly; recent NVIDIA releases changed the human
        // table from "Driver Version" to "KMD Version".
        const output = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'],
            { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
        hasNvidiaGPU = Boolean(output.trim()) && !/no devices|failed|error/i.test(output)
    } catch (error) {
        hasNvidiaGPU = Boolean(error.stdout?.toString().trim()) && !/no devices|failed|error/i.test(error.stdout.toString())
    }
    Log(tag, hasNvidiaGPU ? 'NVIDIA GPU detected - hardware acceleration enabled' : 'No NVIDIA GPU detected - using software encoding')

    gpuCheckDone = true
    return hasNvidiaGPU
}

/**
 * Resolve ffmpeg video encode settings from GPU state and config.
 * Passes VIDEO_CODEC through except when NVENC is requested without a usable GPU path.
 * Exported for unit tests.
 *
 * @param {object} opts
 * @param {boolean} opts.hasGPU
 * @param {boolean} opts.canUseGPU - full CUDA decode+filter+NVENC path is safe for this file
 * @param {boolean} opts.is10Bit
 * @param {string|number} opts.width - target scale width
 * @param {string} opts.filePath - for hybrid-path log message only
 * @param {object} [opts.channel]
 * @param {string} [opts.videoCodecConfig] - defaults to process.env.VIDEO_CODEC
 * @param {string} [opts.videoPreset] - defaults to process.env.VIDEO_PRESET
 * @param {string} [opts.videoCrf] - defaults to process.env.VIDEO_CRF
 * @param {string} [opts.videoFilter] - defaults to process.env.VIDEO_FILTER
 */
function resolveEncodeSettings({
    hasGPU,
    canUseGPU,
    is10Bit,
    width,
    filePath,
    channel,
    videoCodecConfig = VIDEO_CODEC,
    videoPreset = VIDEO_PRESET,
    videoCrf = VIDEO_CRF,
    videoFilter = VIDEO_FILTER
}) {
    const crf = videoCrf || '23'
    const deinterlaceCpu = deinterlacePrefix(videoFilter, false)

    if (canUseGPU) {
        // Full GPU path: NVDEC decode + CUDA filters + NVENC encode
        const deinterlace = deinterlacePrefix(videoFilter, true)
        return {
            inputArgs: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', filePath],
            videoCodec: 'h264_nvenc',
            videoPreset: videoPreset || 'p4',
            qualityArgs: ['-cq', crf, '-rc', 'vbr', '-b:v', '0'],
            fullVideoFilter: `${deinterlace}scale_cuda=${width}:-2,hwdownload,format=nv12`
        }
    }

    if (hasGPU && videoCodecConfig === 'h264_nvenc') {
        // Hybrid path: CPU decode + CPU filters + NVENC encode (for incompatible files)
        Log(tag, `Using CPU decode for ${path.basename(filePath)} (${is10Bit ? '10-bit' : 'incompatible codec'})`, channel)
        return {
            inputArgs: ['-i', filePath],
            videoCodec: 'h264_nvenc',
            videoPreset: videoPreset || 'p4',
            qualityArgs: ['-cq', crf, '-rc', 'vbr', '-b:v', '0'],
            fullVideoFilter: `${deinterlaceCpu}scale=${width}:-2`
        }
    }

    // Configured codec path. Only fall back to software when NVENC was requested without a GPU.
    let videoCodec = videoCodecConfig || 'libx264'
    let resolvedPreset = videoPreset

    if (videoCodec === 'h264_nvenc') {
        videoCodec = 'libx264'
        resolvedPreset = /^(ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow)$/.test(videoPreset || '') ? videoPreset : 'veryfast'
        Log(tag, 'GPU requested but not available - falling back to software encoding', channel)
    } else if (!resolvedPreset) {
        // Sensible defaults when VIDEO_PRESET is unset
        resolvedPreset = videoCodec === 'libx264' ? 'veryfast' : 'medium'
    }

    return {
        inputArgs: ['-i', filePath],
        videoCodec,
        videoPreset: resolvedPreset,
        qualityArgs: ['-crf', crf],
        fullVideoFilter: `${deinterlaceCpu}scale=${width}:-2`
    }
}

class PreGenerator {

    constructor() {
        this.generationQueue = []
        this.channelQueues = [] // Store separate queues per channel
        this.currentIndex = 0
        this.totalVideos = 0
        this.isGenerating = false
        /** @type {Set<import('child_process').ChildProcess>} */
        this.activeProcesses = new Set()
        this.shuttingDown = false
    }

    /**
     * Kill in-flight ffmpeg workers (SIGTERM then SIGKILL) and stop the queue.
     * Called from process shutdown hooks so Ctrl-C / pm2 stop do not orphan encoders.
     */
    stopActiveWorkers() {
        this.shuttingDown = true
        this.generationQueue = []

        const procs = [...this.activeProcesses]
        for (const proc of procs) {
            try {
                if (proc.exitCode === null && proc.signalCode === null) {
                    proc.kill('SIGTERM')
                }
            } catch (_) {
                // Process may already be gone
            }
        }
        for (const proc of procs) {
            try {
                if (proc.exitCode === null && proc.signalCode === null) {
                    proc.kill('SIGKILL')
                }
            } catch (_) {
                // Process may already be gone
            }
        }

        this.activeProcesses.clear()
        this.isGenerating = false

        if (procs.length > 0) {
            Log(tag, `Stopped ${procs.length} in-flight ffmpeg worker(s)`)
        }
    }

    /**
     * Generate a unique hash for a video file path
     * The manifest.json maps these hashes back to original filenames
     */
    getVideoHash(filePath) {
        return crypto.createHash('md5').update(filePath).digest('hex')
    }

    /**
     * Cache-relative path for a per-video unreadable marker (corrupt / unprobeable source).
     */
    unreadableMarkerPath(filePath, channelSlug) {
        const videoHash = this.getVideoHash(filePath)
        return path.join(CACHE_DIR, 'channels', channelSlug, 'videos', videoHash, 'unreadable.json')
    }

    isMarkedUnreadable(filePath, channelSlug) {
        try {
            const marker = this.unreadableMarkerPath(filePath, channelSlug)
            const versioned = path.join(path.dirname(marker), `v${HLS_CACHE_VERSION}`, 'unreadable.json')
            const markerPath = fs.existsSync(versioned) ? versioned : marker
            if (!fs.existsSync(markerPath)) return false
            const data = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
            if (data.sourceSize == null) return !fs.existsSync(filePath)
            const stat = fs.statSync(filePath)
            return stat.size === data.sourceSize && stat.mtimeMs === data.sourceMtimeMs
        } catch (_) {
            return false
        }
    }

    /**
     * Record that a source file cannot be transcoded so the queue does not retry every cycle.
     * Clears any partial HLS output first. Operator can delete unreadable.json after fixing media.
     */
    markMediaUnreadable(outputDir, filePath, reason, extra = {}) {
        try {
            if (fs.existsSync(outputDir)) {
                for (const file of fs.readdirSync(outputDir)) {
                    try {
                        fs.unlinkSync(path.join(outputDir, file))
                    } catch (_) {
                        // best-effort cleanup
                    }
                }
            } else {
                fs.mkdirSync(outputDir, { recursive: true })
            }
            let source = {}
            try { const stat = fs.statSync(filePath); source = { sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs } } catch (_) {}
            const payload = {
                ...source,
                originalPath: filePath,
                reason,
                markedAt: new Date().toISOString(),
                ...extra
            }
            fs.writeFileSync(
                path.join(outputDir, 'unreadable.json'),
                JSON.stringify(payload, null, 2)
            )
        } catch (e) {
            Log(tag, `Could not write unreadable marker for ${path.basename(filePath)}: ${e.message}`, undefined, {
                level: 'warn',
                output_dir: outputDir,
                file_path: filePath,
                reason
            })
        }
    }

    /**
     * Delete a partial/incomplete HLS directory
     */
    deletePartialGeneration(outputDir, fileName) {
        try {
            const files = fs.readdirSync(outputDir)
            for (const file of files) {
                fs.unlinkSync(path.join(outputDir, file))
            }
            fs.rmdirSync(outputDir)
            Log(tag, `Deleted incomplete generation for ${fileName}`)
        } catch (e) {
            Log(tag, `Failed to delete incomplete generation: ${e.message}`, undefined, { error: e, output_dir: outputDir, file_name: fileName })
        }
    }

    /**
     * Reset a database-positive video whose cached HLS output is incomplete
     */
    markGenerationIncomplete(db, video, outputDir, fileName, reason) {
        Log(tag, `${reason} for ${fileName} - marking as not transcoded`)
        try {
            // Use the channel-scoped row returned by getVideoByPath. The same
            // source file can belong to more than one channel.
            db.db.prepare(`
                UPDATE videos
                SET transcoded = 0, segment_count = NULL
                WHERE id = ?
            `).run(video.id)
        } catch (e) {
            Log(tag, `Failed to update database: ${e.message}`, undefined, { error: e, video_id: video && video.id, file_name: fileName, reason })
        }

        if (fs.existsSync(outputDir)) {
            this.deletePartialGeneration(outputDir, fileName)
        }

        return false
    }

    /**
     * Check if HLS files already exist for this video and are complete
     * OPTIMIZED: Check database first before filesystem
     */
    isAlreadyGenerated(filePath, channelSlug, knownVideo) {
        const videoHash = this.getVideoHash(filePath)
        const fileName = path.basename(filePath)

        // Fast check: query database first
        const db = Database()
        const video = knownVideo || db.getVideoByPath(channelSlug, filePath)

        // If not in database or not marked as transcoded, it's not generated
        if (!video || !video.transcoded) {
            return false
        }

        // Database says it's transcoded, but verify files actually exist
        const outputDir = path.join(CACHE_DIR, 'channels', channelSlug, 'videos', videoHash, video.cache_version ? `v${video.cache_version}` : '')
        const playlistPath = path.join(outputDir, 'index.m3u8')

        // Check if playlist exists
        if (!fs.existsSync(playlistPath)) {
            return this.markGenerationIncomplete(
                db,
                video,
                outputDir,
                fileName,
                'Database out of sync'
            )
        }

        // Check if there are actual segment files
        try {
            const files = fs.readdirSync(outputDir)
            const segmentFiles = files.filter(f => f.endsWith('.ts'))

            // If we have a playlist but no segments, it's incomplete
            if (segmentFiles.length === 0) {
                return this.markGenerationIncomplete(
                    db,
                    video,
                    outputDir,
                    fileName,
                    'Incomplete generation detected - no segments found'
                )
            }

            // Check if playlist is complete (has #EXT-X-ENDLIST)
            const playlistContent = fs.readFileSync(playlistPath, 'utf8')
            if (!playlistContent.includes('#EXT-X-ENDLIST')) {
                return this.markGenerationIncomplete(
                    db,
                    video,
                    outputDir,
                    fileName,
                    'Incomplete generation detected - playlist not finalized'
                )
            }

            // Verify all segments referenced in playlist exist
            const parsed = parseHlsPlaylist(playlistContent)
            const segmentRefs = parsed.segments.map(segment => segment.uri)
            const fileSet = new Set(files)
            for (const segmentRef of segmentRefs) {
                if (!fileSet.has(segmentRef)) {
                    return this.markGenerationIncomplete(
                        db,
                        video,
                        outputDir,
                        fileName,
                        `Incomplete generation detected - missing segment ${segmentRef}`
                    )
                }
            }

            const byteRangeEnds = new Map()
            for (const segment of parsed.segments) {
                if (segment.byteRange) byteRangeEnds.set(segment.uri, Math.max(byteRangeEnds.get(segment.uri) || 0, segment.byteRange.start + segment.byteRange.length))
            }
            for (const [uri, end] of byteRangeEnds) {
                if (fs.statSync(path.join(outputDir, uri)).size < end) {
                    return this.markGenerationIncomplete(db, video, outputDir, fileName, 'Truncated byte-range media')
                }
            }

            // Verify metadata.json exists - it's only written after successful transcoding
            const metadataPath = path.join(outputDir, 'metadata.json')
            if (!fs.existsSync(metadataPath)) {
                return this.markGenerationIncomplete(
                    db,
                    video,
                    outputDir,
                    fileName,
                    'Incomplete generation detected - missing metadata.json'
                )
            }

            if (db.updateSegmentMetadata) db.updateSegmentMetadata(video.id, parsed)
            return true
        } catch (e) {
            if (['EACCES', 'EIO', 'ETIMEDOUT', 'ESTALE'].includes(e.code)) {
                Log(tag, `Keeping cached media after storage read error: ${e.message}`, undefined, { level: 'warn' })
                return true
            }
            return this.markGenerationIncomplete(
                db,
                video,
                outputDir,
                fileName,
                `Failed to verify cached generation - ${e.message}`
            )
        }
    }

    /**
     * Get the manifest path for a channel
     */
    getManifestPath(channelSlug) {
        return path.join(CACHE_DIR, 'channels', channelSlug, 'manifest.json')
    }

    /**
     * Update the channel manifest with video metadata
     * Also cleans up removed videos from manifest and deletes their HLS folders
     */
    updateChannelManifest(channel) {
        const manifestPath = this.getManifestPath(channel.slug)
        let manifest = {}

        // Load existing manifest
        try {
            if (fs.existsSync(manifestPath)) {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            }
        } catch (err) {
            Log(tag, `Error loading manifest: ${err.message}`, channel, { error: err, manifest_path: manifestPath })
        }

        // Build set of current video hashes from database
        const db = Database()
        const allVideos = db.getChannelVideos(channel.slug, false)
        const currentHashes = new Set()
        allVideos.forEach(video => {
            currentHashes.add(this.getVideoHash(video.file_path))
        })

        // Find and remove videos that are no longer in the queue
        let removed = 0
        const videosDir = path.join(CACHE_DIR, 'channels', channel.slug, 'videos')
        for (const hash of Object.keys(manifest)) {
            if (!/^[a-f0-9]{32}$/.test(hash)) { delete manifest[hash]; continue }
            if (!currentHashes.has(hash)) {
                const videoDir = path.join(videosDir, hash)
                const filename = manifest[hash].filename || hash

                // Delete the HLS folder
                if (fs.existsSync(videoDir)) {
                    try {
                        fs.rmSync(videoDir, { recursive: true })
                        Log(tag, `Deleted HLS folder for removed video: ${filename}`, channel)
                    } catch (err) {
                        Log(tag, `Failed to delete HLS folder for ${filename}: ${err.message}`, channel)
                    }
                }

                // Remove from manifest
                delete manifest[hash]
                removed++
            }
        }

        // Add new videos to manifest
        let added = 0
        allVideos.forEach(video => {
            const videoHash = this.getVideoHash(video.file_path)
            if (!manifest[videoHash]) {
                manifest[videoHash] = {
                    originalPath: video.file_path,
                    filename: path.basename(video.file_path, path.extname(video.file_path)),
                    addedAt: Date.now()
                }
                added++
            }
        })

        // Clean up orphaned HLS folders (exist on disk but not in manifest or queue)
        let orphansDeleted = 0
        if (fs.existsSync(videosDir)) {
            try {
                const existingFolders = fs.readdirSync(videosDir).filter(folder => /^[a-f0-9]{32}$/.test(folder))
                for (const folder of existingFolders) {
                    if (!currentHashes.has(folder)) {
                        const orphanDir = path.join(videosDir, folder)
                        try {
                            fs.rmSync(orphanDir, { recursive: true })
                            Log(tag, `Deleted orphaned HLS folder: ${folder}`, channel)
                            orphansDeleted++
                        } catch (err) {
                            Log(tag, `Failed to delete orphaned folder ${folder}: ${err.message}`, channel)
                        }
                    }
                }
            } catch (err) {
                Log(tag, `Error scanning videos directory: ${err.message}`, channel)
            }
        }

        // Save manifest
        const dir = path.dirname(manifestPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

        if (added > 0 || removed > 0 || orphansDeleted > 0) {
            Log(tag, `Manifest updated: +${added} added, -${removed} removed, ${orphansDeleted} orphans deleted`, channel)
        }

        return manifest
    }

    /**
     * Add a channel's videos to the generation queue
     * OPTIMIZED: Single bulk database query instead of N individual queries
     * Manifest updates are deferred to avoid blocking startup
     */
    queueChannel(channel) {
        for (const unused of this.scanChannel(channel)) { /* synchronous compatibility */ }
    }

    async queueChannelAsync(channel) {
        let checkpoint = Date.now()
        for (const unused of this.scanChannel(channel)) {
            if (Date.now() - checkpoint >= 20) {
                await new Promise(resolve => setImmediate(resolve))
                checkpoint = Date.now()
            }
            if (this.shuttingDown) break
        }
    }

    *scanChannel(channel) {
        // Defer manifest update to background - don't block startup
        this.pendingManifestUpdates = this.pendingManifestUpdates || []
        this.pendingManifestUpdates.push(channel)

        // Get all videos from database - both transcoded and not
        const db = Database()
        const allVideos = db.getChannelVideos(channel.slug, false) // all videos
        const transcodedVideos = db.getChannelVideos(channel.slug, true) // transcoded only
        const transcodedPaths = new Set(transcodedVideos.map(v => v.file_path))

        const channelQueue = []
        let skippedCount = 0

        for (const video of allVideos) {
            yield video
            // Corrupt/unreadable sources are marked once and left out of the queue.
            if (this.isMarkedUnreadable(video.file_path, channel.slug)) {
                skippedCount++
                continue
            }
            // Database-positive rows still need their cached files verified.
            if (
                transcodedPaths.has(video.file_path) &&
                this.isAlreadyGenerated(video.file_path, channel.slug, video) &&
                (video.cache_version || 0) >= HLS_CACHE_VERSION
            ) {
                skippedCount++
            } else {
                // Not transcoded or cache is incomplete, needs transcoding
                channelQueue.push({
                    videoId: video.id,
                    filePath: video.file_path,
                    channel
                })
            }
        }

        // Restore missing or quarantined streams before rebuilding healthy ones.
        channelQueue.sort((a, b) => Number(transcodedPaths.has(a.filePath)) - Number(transcodedPaths.has(b.filePath)))
        if (channelQueue.length > 0) {
            this.channelQueues.push(channelQueue)
        }

        const skippedMsg = skippedCount > 0 ? ` (${skippedCount} already generated)` : ''
        Log(tag, `Queued ${channelQueue.length} videos for generation${skippedMsg}`, channel)
    }

    /**
     * Build interleaved queue from all channels (round-robin)
     */
    buildInterleavedQueue() {
        this.generationQueue = []
        let hasMore = true

        while (hasMore) {
            hasMore = false
            for (const channelQueue of this.channelQueues) {
                if (channelQueue.length > 0) {
                    this.generationQueue.push(channelQueue.shift())
                    hasMore = true
                }
            }
        }

        this.totalVideos = this.generationQueue.length
    }

    /**
     * Pull a short human-readable reason from an execFileSync/ffprobe failure.
     * Prefer stderr (demuxer detail). Never fall back to Node's "Command failed: …"
     * string — the word "failed" makes OrchLogShipper classify the skip line as ERROR.
     */
    describeProbeFailure(err) {
        const stderr = err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
        if (stderr) {
            // Last non-empty line is usually the concise summary (e.g. Invalid data found…)
            const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
            const summary = lines[lines.length - 1] || stderr
            return summary.length > 300 ? `${summary.slice(0, 300)}…` : summary
        }
        return 'ffprobe could not read media'
    }

    /**
     * Get video file info using ffprobe
     */
    getVideoInfo(filePath) {
        // Pass filePath as an argv element (execFileSync, no shell) so media
        // names with quotes/metacharacters cannot inject into a shell string.
        try {
            // Get video stream info
            const videoResult = execFileSync(
                'ffprobe',
                [
                    '-v', 'error',
                    '-select_streams', 'v:0',
                    '-show_entries', 'stream=codec_name,pix_fmt,width,height,bit_depth',
                    '-of', 'csv=p=0',
                    filePath
                ],
                { encoding: 'utf8', timeout: 10000 }
            )
            const videoParts = videoResult.trim().split(',')

            // Get audio stream info
            let audioCodec = 'unknown'
            try {
                const audioResult = execFileSync(
                    'ffprobe',
                    [
                        '-v', 'error',
                        '-select_streams', 'a:0',
                        '-show_entries', 'stream=codec_name',
                        '-of', 'csv=p=0',
                        filePath
                    ],
                    { encoding: 'utf8', timeout: 10000 }
                )
                audioCodec = audioResult.trim() || 'unknown'
            } catch (e) {
                audioCodec = 'none'
            }

            return {
                codec: videoParts[0] || 'unreadable',
                width: videoParts[1] || 'unknown',
                height: videoParts[2] || 'unknown',
                pixFmt: videoParts[3] || 'unknown',
                bitDepth: videoParts[4] || '8',
                audioCodec: audioCodec,
                probeFailed: false
            }
        } catch (e) {
            // Placeholder avoids the word "error" in codec — that string rides into the
            // Processing log line and OrchLogShipper classifies it as ERROR.
            return {
                codec: 'unreadable',
                width: '?',
                height: '?',
                pixFmt: '?',
                bitDepth: '?',
                audioCodec: '?',
                unreadable: true,
                probeFailed: true,
                probeError: this.describeProbeFailure(e)
            }
        }
    }

    async probeJson(filePath, extraArgs = []) {
        return new Promise((resolve, reject) => {
            const probe = execFile('ffprobe', ['-v', 'error', ...extraArgs, '-show_streams', '-of', 'json', filePath],
                { encoding: 'utf8', timeout: extraArgs.length ? 120000 : 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
                if (error) return reject(error)
                try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
            })
            this.activeProcesses.add(probe)
            probe.once('close', () => this.activeProcesses.delete(probe))
        })
    }

    async probeVideo(filePath) {
        try {
            const streams = (await this.probeJson(filePath)).streams || []
            const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
            if (!video) return { codec: 'unreadable', probeFailed: true }
            const audio = streams.find(stream => stream.codec_type === 'audio')
            const candidate = timingCandidate(video, audio)
            let timingRepair = null
            if (candidate) {
                const counted = await this.probeJson(filePath, ['-select_streams', String(video.index), '-count_packets'])
                timingRepair = confirmTimingRepair(candidate, counted.streams?.[0]?.nb_read_packets)
            }
            return { codec: video.codec_name, width: video.width, height: video.height,
                streamIndex: video.index, audioIndex: audio?.index, timingRepair,
                pixFmt: video.pix_fmt, bitDepth: video.bits_per_raw_sample || '8', audioCodec: audio?.codec_name || 'none' }
        } catch (error) {
            return { codec: 'unreadable', probeFailed: true, probeError: this.describeProbeFailure(error) }
        }
    }

    /**
     * Generate HLS files for a single video
     */
    async generateVideo(videoId, filePath, channel, options = {}) {
        const videoInfo = await this.probeVideo(filePath)
        if (this.shuttingDown) throw new Error('Generation is stopping')
        return new Promise((resolve, reject) => {
            const videoHash = this.getVideoHash(filePath)
            const outputDir = path.join(CACHE_DIR, 'channels', channel.slug, 'videos', videoHash, `v${HLS_CACHE_VERSION}`)
            const outputPath = path.join(outputDir, 'index.m3u8')
            const baseName = path.basename(filePath)

            // Probe first. Corrupt/empty/truncated library files (e.g. invalid EBML at byte 0)
            // must not spawn ffmpeg or emit a Processing line that looks like a software ERROR.
            if (isUnreadableProbeResult(videoInfo) || videoInfo.probeFailed) {
                const reason = videoInfo.probeError || 'probe found no usable streams'
                // Permanent marker so queueChannel skips this source on later cycles.
                this.markMediaUnreadable(outputDir, filePath, 'ffprobe_failed', {
                    probe_error: reason
                })
                // Wording deliberately avoids error/failed/unable so classifyLevel → warn via "Skipping".
                Log(tag, `Skipping unreadable media ${baseName} — ${reason}`, channel, {
                    level: 'warn',
                    file_path: filePath,
                    video_hash: videoHash,
                    video_id: videoId,
                    reason: 'probe_unreadable',
                    probe_error: reason
                })
                resolve({ skipped: true, reason: 'unreadable' })
                return
            }

            if (videoInfo.timingRepair) {
                Database().quarantineVideo(videoId)
                const marker = path.join(path.dirname(outputDir), 'invalid-cache.json')
                fs.mkdirSync(path.dirname(marker), { recursive: true })
                fs.writeFileSync(marker, JSON.stringify({ reason: 'stretched_source_timestamps', timingRepair: videoInfo.timingRepair }))
                channel.guideGenerator?.invalidateCache()
                channel.playlistManager?.invalidateCache()
            }

            // Create output directory only when we intend to encode
            fs.mkdirSync(outputDir, { recursive: true })

            // Log video info before transcoding
            Log(tag, `Processing ${baseName} [${videoInfo.codec} ${videoInfo.width}x${videoInfo.height} ${videoInfo.pixFmt} ${videoInfo.bitDepth}bit | audio: ${videoInfo.audioCodec}]`, channel)

            if (videoInfo.timingRepair) Log(tag, `Repairing stretched video timestamps at ${videoInfo.timingRepair.fps} fps`, channel)
            const hasGPU = !options.forceCpu && checkNvidiaGPU()
            const [width] = (DIMENSIONS || '640x480').split('x')

            // Check if this file can use GPU - 10-bit and some codecs don't work well with CUDA filters
            const is10Bit = videoInfo.pixFmt && (videoInfo.pixFmt.includes('10') || videoInfo.bitDepth === '10')
            const gpuCompatibleCodecs = ['h264', 'hevc', 'vp9', 'mpeg2video']
            const canUseGPU = hasGPU &&
                              VIDEO_CODEC === 'h264_nvenc' &&
                              !is10Bit &&
                              gpuCompatibleCodecs.includes(videoInfo.codec)

            const {
                videoCodec,
                videoPreset,
                inputArgs,
                qualityArgs,
                fullVideoFilter
            } = resolveEncodeSettings({
                hasGPU,
                canUseGPU,
                is10Bit,
                width,
                filePath,
                channel
            })

            // Fixed AAC stereo format prevents decoder changes between programs.
            const audioArgs = ['-c:a', 'aac', '-b:a', AUDIO_BITRATE || '192k', '-ac', '2', '-ar', '48000']
            const segmentSeconds = Math.max(1, Number(HLS_SEGMENT_LENGTH_SECONDS) || 2)

            const args = [
                '-hide_banner', '-nostdin', '-y', '-filter_threads', '2', '-threads', '4',
                ...inputArgs,
                ...(videoInfo.audioCodec === 'none' ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'] : []),
                '-map', videoInfo.streamIndex == null ? '0:v:0' : `0:${videoInfo.streamIndex}`, '-map', videoInfo.audioCodec === 'none' ? '1:a:0' : (videoInfo.audioIndex == null ? '0:a:0' : `0:${videoInfo.audioIndex}`), '-sn', '-dn',
                '-shortest', '-af', 'apad',
                '-vf', (videoInfo.timingRepair ? `setpts=N/(${videoInfo.timingRepair.fps}*TB),` : '') + fullVideoFilter,
                ...(videoInfo.timingRepair ? ['-r', String(videoInfo.timingRepair.fps)] : []),
                '-c:v', videoCodec, '-threads', '4',
                '-preset', videoPreset,
                ...qualityArgs,
                '-profile:v', 'main',
                '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`,
                ...(videoCodec === 'h264_nvenc' ? ['-forced-idr', '1'] : []),
                '-flags', '+cgop',
                '-pix_fmt', 'yuv420p',
                ...audioArgs,
                '-hls_time', String(segmentSeconds),
                '-hls_flags', 'independent_segments+single_file',
                // Cached videos are published only after completion. Write the
                // growing VOD index once, avoiding quadratic playlist rewrites.
                '-hls_playlist_type', 'vod',
                '-hls_list_size', '0',
                '-hls_segment_filename', path.join(outputDir, 'stream.ts'),
                '-f', 'hls',
                outputPath
            ]

            const ffmpeg = spawn('ffmpeg', args)
            this.activeProcesses.add(ffmpeg)
            let lastOutput = Date.now()
            const watchdog = setInterval(() => {
                if (Date.now() - lastOutput > 120000) ffmpeg.kill('SIGKILL')
            }, 15000)
            const untrack = () => { clearInterval(watchdog); this.activeProcesses.delete(ffmpeg) }
            ffmpeg.once('close', untrack)
            ffmpeg.once('error', untrack)

            const startTime = Date.now()
            let stderrData = ''

            ffmpeg.stderr.on('data', (data) => {
                lastOutput = Date.now()
                stderrData = (stderrData + data.toString()).slice(-32768)
            })

            ffmpeg.on('close', (code) => {
                if (this.shuttingDown) {
                    reject(new Error('FFmpeg stopped during shutdown'))
                    return
                }
                if (code === 0) {
                  try {
                    const duration = (Date.now() - startTime) / 1000
                    Log(tag, `Generated ${baseName} in ${duration.toFixed(1)}s [${this.currentIndex}/${this.totalVideos}]`, channel)

                    const parsed = parseHlsPlaylist(fs.readFileSync(outputPath, 'utf8'))
                    if (!parsed.complete) throw new Error('Encoder did not finalize playlist')
                    if (parsed.maxDuration > segmentSeconds + 0.5) throw new Error(`Segments exceed keyframe interval: ${parsed.maxDuration}s`)
                    const streamBytes = fs.statSync(path.join(outputDir, 'stream.ts')).size
                    if (parsed.segments.some(segment => !segment.byteRange || segment.byteRange.start + segment.byteRange.length > streamBytes)) throw new Error('Incomplete byte-range media file')
                    const videoDuration = parsed.duration
                    if (videoInfo.timingRepair && Math.abs(videoDuration - videoInfo.timingRepair.duration) > Math.max(2, videoInfo.timingRepair.duration * 0.01)) throw new Error('Repaired video does not match its frame-count duration')
                    const segmentCount = parsed.segments.length

                    // Store metadata
                    const metadata = {
                        originalPath: filePath,
                        videoHash: videoHash,
                        generatedAt: new Date().toISOString(),
                        duration: videoDuration,
                        encodingSeconds: duration,
                        timingRepair: videoInfo.timingRepair || null,
                        maxSegmentDuration: parsed.maxDuration,
                        cacheVersion: HLS_CACHE_VERSION,
                        segmentCount: segmentCount
                    }
                    fs.writeFileSync(
                        path.join(outputDir, 'metadata.json'),
                        JSON.stringify(metadata, null, 2)
                    )

                    // Update database with transcoding status
                    try {
                        const db = Database()
                        db.markVideoTranscoded(
                            videoId,
                            videoDuration,
                            segmentCount,
                            videoInfo.codec,
                            videoInfo.audioCodec,
                            parseInt(videoInfo.width) || null,
                            parseInt(videoInfo.height) || null,
                            HLS_CACHE_VERSION
                        )
                        db.updateSegmentMetadata(videoId, parsed)
                    } catch (dbErr) {
                        throw dbErr
                    }

                    const invalidMarker = path.join(path.dirname(outputDir), 'invalid-cache.json')
                    if (fs.existsSync(invalidMarker)) fs.unlinkSync(invalidMarker)

                    // Invalidate playlist cache so newly transcoded video appears
                    if (channel.playlistManager) {
                        // Leave on-air segment numbering and program timing intact.
                        const guide = channel.guideGenerator?.cachedGuide
                        if (!guide || guide.schedule.length === 0) channel.playlistManager.invalidateCache()
                    }

                    resolve()
                  } catch (error) {
                    reject(error)
                  }
                } else if (hasGPU && !options.forceCpu) {
                    Log(tag, `Retrying ${baseName} with software encoding`, channel)
                    this.generateVideo(videoId, filePath, channel, { forceCpu: true }).then(resolve, reject)
                } else if (isUnreadableMediaStderr(stderrData)) {
                    // Library media problem, not an encode-path bug. One warn line; no raw Error: dump.
                    // Mark permanently so queueChannel does not re-queue every cycle.
                    const tail = stderrData.slice(-500)
                    this.markMediaUnreadable(outputDir, filePath, 'ffmpeg_invalid_input', {
                        exit_code: code,
                        ffmpeg_stderr_tail: tail
                    })
                    Log(tag, `Skipping unreadable media ${baseName} (encode exit ${code})`, channel, {
                        level: 'warn',
                        exit_code: code,
                        file_path: filePath,
                        video_hash: videoHash,
                        reason: 'encode_unreadable',
                        ffmpeg_stderr_tail: tail
                    })
                    resolve({ skipped: true, reason: 'unreadable' })
                } else {
                    // Unexpected encode failure. Avoid the log-monitor signature "Failed to generate".
                    // Keep stderr detail in context only — a second "Error: …" line was a signature of its own.
                    Log(tag, `Could not generate ${baseName} (exit code ${code})`, channel, {
                        level: 'error',
                        exit_code: code,
                        file_path: filePath,
                        video_hash: videoHash,
                        ffmpeg_stderr_tail: stderrData.slice(-500)
                    })
                    reject(new Error(`FFmpeg exited with code ${code}`))
                }
            })

            ffmpeg.on('error', (err) => {
                Log(tag, `Could not start ffmpeg for ${baseName}: ${err.message}`, channel, {
                    level: 'error',
                    error: err,
                    file_path: filePath,
                    video_hash: videoHash
                })
                reject(err)
            })
        })
    }

    /**
     * Process deferred manifest updates (runs in background during generation)
     */
    async processPendingManifestUpdates() {
        if (!this.pendingManifestUpdates || this.pendingManifestUpdates.length === 0) {
            return
        }

        Log(tag, `Updating manifests for ${this.pendingManifestUpdates.length} channels...`)

        for (const channel of this.pendingManifestUpdates) {
            // Yield to event loop between channels
            await new Promise(resolve => setImmediate(resolve))
            this.updateChannelManifest(channel)
        }

        this.pendingManifestUpdates = []
        Log(tag, 'Manifest updates complete')
    }

    /**
     * Process the generation queue sequentially
     */
    async startGeneration() {
        if (this.isGenerating) {
            Log(tag, 'Generation already in progress')
            return
        }

        // Process deferred manifest updates first (in background)
        await this.processPendingManifestUpdates()

        // Build interleaved queue before starting
        this.buildInterleavedQueue()

        if (this.generationQueue.length === 0) {
            Log(tag, 'All videos already generated!')
            return
        }

        this.isGenerating = true
        this.currentIndex = 0

        Log(tag, `Starting generation of ${this.totalVideos} videos (round-robin across channels)...`)

        this.completedVideos = 0
        this.failedVideos = 0
        this.skippedVideos = 0
        let nextIndex = 0
        const workers = Math.max(1, Math.min(4, Number(process.env.GENERATION_WORKERS) ||
            (VIDEO_CODEC === 'h264_nvenc' && checkNvidiaGPU() ? 2 : 1)))
        Log(tag, `Using ${workers} background encoder worker(s)`)
        const work = async () => {
            while (!this.shuttingDown && !this.pausedReason && nextIndex < this.generationQueue.length) {
                try {
                    const disk = fs.statfsSync(CACHE_DIR)
                    if (disk.bavail * disk.bsize < 5 * 1024 ** 3) {
                        this.pausedReason = 'Less than 5 GiB free; restart after freeing space to resume'
                        break
                    }
                } catch (_) { /* filesystems without statfs still support encoding */ }
                const item = this.generationQueue[nextIndex++]
                this.currentIndex++
                try {
                    const result = await this.generateVideo(item.videoId, item.filePath, item.channel)
                    if (result?.skipped) this.skippedVideos++
                } catch (error) {
                    if (this.shuttingDown) break
                    if (error?.code === 'UNREADABLE_MEDIA' || error?.mediaSkip || error?.unreadable) this.skippedVideos++
                    else {
                        this.failedVideos++
                        Log(tag, `Skipping video after encode exit: ${item.filePath}`, item.channel, {
                            file_path: item.filePath, reason: error?.message || 'encode_exit'
                        })
                    }
                }
                this.completedVideos++
            }
        }
        await Promise.all(Array.from({ length: workers }, work))

        this.isGenerating = false
        if (this.shuttingDown) {
            Log(tag, 'Generation stopped during shutdown')
        } else if (this.pausedReason) {
            Log(tag, `Generation paused: ${this.pausedReason}`)
        } else {
            Log(tag, `Generation complete! Processed ${this.totalVideos} videos.`)
        }
    }

    /**
     * Get progress information
     */
    getProgress() {
        return {
            current: this.completedVideos || 0,
            activeVideos: this.currentIndex - (this.completedVideos || 0),
            failedVideos: this.failedVideos || 0,
            skippedVideos: this.skippedVideos || 0,
            total: this.totalVideos,
            isGenerating: this.isGenerating,
            pausedReason: this.pausedReason || null,
            percentComplete: this.totalVideos > 0
                ? Math.round(((this.completedVideos || 0) / this.totalVideos) * 100)
                : 100
        }
    }
}

const preGenerator = new PreGenerator()
module.exports = preGenerator
module.exports.resolveEncodeSettings = resolveEncodeSettings
module.exports.deinterlacePrefix = deinterlacePrefix
module.exports.isUnreadableProbeResult = isUnreadableProbeResult
module.exports.isUnreadableMediaStderr = isUnreadableMediaStderr

