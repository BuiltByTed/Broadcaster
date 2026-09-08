const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const preGeneratorPath = require.resolve('../Utilities/PreGenerator.js')
const guideGeneratorPath = require.resolve('../Utilities/GuideGenerator.js')
const playlistManagerPath = require.resolve('../Classes/PlaylistManager.js')
const databasePath = require.resolve('../Utilities/Database.js')
const logPath = require.resolve('../Utilities/Log.js')

function loadPreGenerator(cacheDir, db, options = {}) {
    process.env.CACHE_DIR = cacheDir
    delete require.cache[preGeneratorPath]
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: () => db
    }
    const logs = options.logs || null
    require.cache[logPath] = {
        id: logPath,
        filename: logPath,
        loaded: true,
        exports: (tag, message, channel, context) => {
            if (logs) logs.push({ tag, message, channel, context })
        }
    }

    return require(preGeneratorPath)
}

function createDatabase(filePath, updates) {
    const video = {
        id: 41,
        file_path: filePath,
        hash: crypto.createHash('md5').update(filePath).digest('hex'),
        transcoded: 1,
        duration_seconds: 20,
        segment_count: 2
    }

    return {
        video,
        getChannelVideos(channelSlug, transcodedOnly) {
            assert.equal(channelSlug, 'news')
            return !transcodedOnly || video.transcoded ? [video] : []
        },
        getVideoByPath(channelSlug, requestedPath) {
            assert.equal(channelSlug, 'news')
            assert.equal(requestedPath, filePath)
            return video
        },
        getVideoByHash(channelSlug, requestedHash) {
            assert.equal(channelSlug, 'news')
            assert.equal(requestedHash, video.hash)
            return video
        },
        db: {
            prepare(sql) {
                return {
                    run(...args) {
                        updates.push({ sql, args })
                        if (/transcoded\s*=\s*0/i.test(sql)) {
                            video.transcoded = 0
                        }
                        if (/segment_count\s*=\s*NULL/i.test(sql)) {
                            video.segment_count = null
                        }
                    }
                }
            }
        }
    }
}

function createCacheDir(cacheDir, video, files) {
    const outputDir = path.join(
        cacheDir,
        'channels',
        'news',
        'videos',
        video.hash
    )
    fs.mkdirSync(outputDir, { recursive: true })

    for (const [fileName, contents] of Object.entries(files)) {
        fs.writeFileSync(path.join(outputDir, fileName), contents)
    }

    return outputDir
}

function queueSingleVideo(preGenerator) {
    const channel = { slug: 'news' }
    preGenerator.queueChannel(channel)
    return { channel, queue: preGenerator.channelQueues[0] }
}

test('queues a database-positive video when its cache directory is missing', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    const preGenerator = loadPreGenerator(cacheDir, db)

    const { channel, queue } = queueSingleVideo(preGenerator)

    assert.deepEqual(queue, [{ videoId: db.video.id, filePath, channel }])
    assert.equal(updates.length, 1)
    assert.match(updates[0].sql, /segment_count\s*=\s*NULL/i)
    assert.match(updates[0].sql, /WHERE id = \?/)
    assert.deepEqual(updates[0].args, [db.video.id])
})

test('queues a database-positive video when a referenced segment is missing', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    const outputDir = createCacheDir(cacheDir, db.video, {
        'index.m3u8': [
            '#EXTM3U',
            '#EXTINF:10.0,',
            'segment_00000.ts',
            '#EXTINF:10.0,',
            'segment_00001.ts',
            '#EXT-X-ENDLIST'
        ].join('\n'),
        'segment_00000.ts': 'segment',
        'metadata.json': '{}'
    })
    const preGenerator = loadPreGenerator(cacheDir, db)

    const { queue } = queueSingleVideo(preGenerator)

    assert.equal(queue.length, 1)
    assert.deepEqual(updates[0].args, [db.video.id])
    assert.equal(fs.existsSync(outputDir), false)
})

test('queues a legacy rebuild while keeping its complete cache playable', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    createCacheDir(cacheDir, db.video, {
        'index.m3u8': [
            '#EXTM3U',
            '#EXTINF:10.0,',
            'segment_00000.ts',
            '#EXT-X-ENDLIST'
        ].join('\n'),
        'segment_00000.ts': 'segment',
        'metadata.json': '{}'
    })
    const preGenerator = loadPreGenerator(cacheDir, db)

    queueSingleVideo(preGenerator)

    assert.equal(preGenerator.channelQueues[0].length, 1)
    assert.equal(db.video.transcoded, 1)
    assert.deepEqual(updates, [])
})

test('resolveEncodeSettings passes VIDEO_CODEC for videotoolbox, qsv, and libx264', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const resolve = preGenerator.resolveEncodeSettings

    for (const codec of ['h264_videotoolbox', 'h264_qsv', 'libx264']) {
        const settings = resolve({
            hasGPU: false,
            canUseGPU: false,
            is10Bit: false,
            width: '640',
            filePath: '/library/news.mkv',
            videoCodecConfig: codec,
            videoPreset: codec === 'libx264' ? 'faster' : 'medium',
            videoCrf: '20',
            videoFilter: 'yadif'
        })
        assert.equal(settings.videoCodec, codec)
        assert.equal(settings.videoPreset, codec === 'libx264' ? 'faster' : 'medium')
        assert.deepEqual(settings.qualityArgs, ['-crf', '20'])
        assert.equal(settings.inputArgs[0], '-i')
        assert.match(settings.fullVideoFilter, /yadif,scale=640:-2/)
    }
})

test('resolveEncodeSettings uses full NVENC path when canUseGPU', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: true,
        canUseGPU: true,
        is10Bit: false,
        width: '1280',
        filePath: '/library/news.mkv',
        videoCodecConfig: 'h264_nvenc',
        videoPreset: 'p5',
        videoCrf: '22',
        videoFilter: 'yadif'
    })
    assert.equal(settings.videoCodec, 'h264_nvenc')
    assert.equal(settings.videoPreset, 'p5')
    assert.deepEqual(settings.qualityArgs, ['-cq', '22', '-rc', 'vbr', '-b:v', '0'])
    assert.deepEqual(settings.inputArgs.slice(0, 4), [
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'
    ])
    assert.match(settings.fullVideoFilter, /yadif_cuda,scale_cuda=1280:-2/)
})

test('resolveEncodeSettings hybrid NVENC when GPU present but canUseGPU false', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: true,
        canUseGPU: false,
        is10Bit: true,
        width: '640',
        filePath: '/library/hdr.mkv',
        videoCodecConfig: 'h264_nvenc',
        videoPreset: undefined,
        videoCrf: undefined,
        videoFilter: 'yadif'
    })
    assert.equal(settings.videoCodec, 'h264_nvenc')
    assert.equal(settings.videoPreset, 'p4')
    assert.deepEqual(settings.qualityArgs, ['-cq', '23', '-rc', 'vbr', '-b:v', '0'])
    assert.deepEqual(settings.inputArgs, ['-i', '/library/hdr.mkv'])
})

test('resolveEncodeSettings falls back to libx264 when NVENC requested without GPU', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: false,
        canUseGPU: false,
        is10Bit: false,
        width: '640',
        filePath: '/library/news.mkv',
        videoCodecConfig: 'h264_nvenc',
        videoPreset: undefined,
        videoCrf: '23',
        videoFilter: 'yadif'
    })
    assert.equal(settings.videoCodec, 'libx264')
    assert.equal(settings.videoPreset, 'veryfast')
    assert.deepEqual(settings.qualityArgs, ['-crf', '23'])
})

test('resolveEncodeSettings does not force NVENC when another codec is configured on a GPU host', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: true,
        canUseGPU: false,
        is10Bit: false,
        width: '640',
        filePath: '/library/news.mkv',
        videoCodecConfig: 'h264_videotoolbox',
        videoPreset: 'fast',
        videoCrf: '18',
        videoFilter: ''
    })
    assert.equal(settings.videoCodec, 'h264_videotoolbox')
    assert.equal(settings.videoPreset, 'fast')
    assert.deepEqual(settings.qualityArgs, ['-crf', '18'])
    assert.equal(settings.fullVideoFilter, 'scale=640:-2')
})

test('persisted guide cannot emit deleted segment URLs after restart', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    const preGenerator = loadPreGenerator(cacheDir, db)

    queueSingleVideo(preGenerator)

    assert.equal(db.video.transcoded, 0)
    assert.equal(db.video.segment_count, null)

    delete require.cache[guideGeneratorPath]
    delete require.cache[playlistManagerPath]
    const { GuideGenerator, getPrevious3am } = require(guideGeneratorPath)
    const { PlaylistManager } = require(playlistManagerPath)
    const channel = { slug: 'news', name: 'News' }
    const now = Date.now()
    const persistedGuide = {
        dayStart: getPrevious3am(now),
        schedule: [{
            hash: db.video.hash,
            startTime: now - 1000,
            endTime: now + 19000
        }]
    }
    new GuideGenerator(channel).saveGuide(persistedGuide)

    delete require.cache[guideGeneratorPath]
    delete require.cache[playlistManagerPath]
    const { GuideGenerator: RestartedGuideGenerator } = require(guideGeneratorPath)
    const { PlaylistManager: RestartedPlaylistManager } = require(playlistManagerPath)
    const restartedGuideGenerator = new RestartedGuideGenerator(channel)
    const restartedPlaylistManager = new RestartedPlaylistManager(channel)
    restartedPlaylistManager.setGuideGenerator(restartedGuideGenerator)

    const reloadedGuide = restartedGuideGenerator.getActiveGuide()
    const playlist = restartedPlaylistManager.createRollingPlaylist()

    assert.deepEqual(reloadedGuide.schedule, [])
    assert.equal(playlist, null)
})

test('stopActiveWorkers SIGTERMs then SIGKILLs tracked ffmpeg children', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))

    const signals = []
    const fakeChild = {
        exitCode: null,
        signalCode: null,
        kill(sig) {
            signals.push(sig)
            if (sig === 'SIGKILL') {
                this.signalCode = 'SIGKILL'
            }
        }
    }

    preGenerator.activeProcesses.add(fakeChild)
    preGenerator.generationQueue = [{ videoId: 1, filePath: '/x', channel: { slug: 'news' } }]
    preGenerator.isGenerating = true

    preGenerator.stopActiveWorkers()

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(preGenerator.activeProcesses.size, 0)
    assert.deepEqual(preGenerator.generationQueue, [])
    assert.equal(preGenerator.isGenerating, false)
    assert.equal(preGenerator.shuttingDown, true)
})

test('stopActiveWorkers is a no-op when no workers are active', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))

    assert.doesNotThrow(() => preGenerator.stopActiveWorkers())
    assert.equal(preGenerator.activeProcesses.size, 0)
    assert.equal(preGenerator.shuttingDown, true)
})

test('stopActiveWorkers skips kill when process already exited', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))

    let killCalls = 0
    preGenerator.activeProcesses.add({
        exitCode: 0,
        signalCode: null,
        kill() {
            killCalls++
        }
    })

    preGenerator.stopActiveWorkers()

    assert.equal(killCalls, 0)
    assert.equal(preGenerator.activeProcesses.size, 0)
})

test('getVideoInfo passes media path as execFileSync argv (no shell)', t => {
    const childProcess = require('child_process')
    const maliciousPath = '/library/evil"; touch /tmp/pwned; echo ".mkv'
    const calls = []

    t.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
        calls.push({ cmd, args, opts })
        if (Array.isArray(args) && args.includes('a:0')) {
            return 'aac\n'
        }
        return 'h264,yuv420p,1920,1080,8\n'
    })

    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase(maliciousPath, []))
    const info = preGenerator.getVideoInfo(maliciousPath)

    assert.equal(info.codec, 'h264')
    assert.equal(info.audioCodec, 'aac')
    assert.equal(info.probeFailed, false)
    assert.equal(calls.length, 2)

    for (const call of calls) {
        assert.equal(call.cmd, 'ffprobe')
        assert.ok(Array.isArray(call.args), 'args must be an array (no shell string)')
        assert.equal(call.args[call.args.length - 1], maliciousPath)
        assert.equal(call.args.includes(maliciousPath), true)
        // Path must not be interpolated into a single shell command string
        assert.equal(typeof call.args, 'object')
        for (const arg of call.args) {
            assert.equal(String(arg).includes('touch /tmp/pwned'), arg === maliciousPath)
        }
        assert.equal(call.opts && call.opts.shell, undefined)
    }
})

test('isUnreadableMediaStderr matches EBML / invalid-data library failures', () => {
    const { isUnreadableMediaStderr } = require('../Utilities/PreGenerator.js')
    const snlStderr = [
        'Error: core of 1, misdetection possible!',
        '[matroska,webm @ 0x5562b5598480] 0x00 at pos 0 (0x0) invalid as first byte of an EBML number',
        '[matroska,webm @ 0x5562b5598480] EBML header parsing failed',
        '[in#0 @ 0x5562b5598380] Error opening input: Invalid data found when processing input',
        'Error opening input file /media/TV Shows/Saturday Night Live.mkv.',
        'Error opening input files: Invalid data found when processing input'
    ].join('\n')

    assert.equal(isUnreadableMediaStderr(snlStderr), true)
    assert.equal(isUnreadableMediaStderr('moov atom not found'), true)
    assert.equal(isUnreadableMediaStderr('No such file or directory'), true)
    assert.equal(isUnreadableMediaStderr('does not contain any stream'), true)
    assert.equal(isUnreadableMediaStderr('could not find codec parameters'), true)
    assert.equal(isUnreadableMediaStderr('Conversion failed!'), false)
    assert.equal(isUnreadableMediaStderr(''), false)
    assert.equal(isUnreadableMediaStderr(null), false)
    assert.equal(isUnreadableMediaStderr('frame=  120 fps=30 q=28.0 size=N/A time=00:00:04.00'), false)
})

test('isUnreadableProbeResult detects probe placeholders', () => {
    const { isUnreadableProbeResult } = require('../Utilities/PreGenerator.js')
    assert.equal(isUnreadableProbeResult({ codec: 'unreadable' }), true)
    assert.equal(isUnreadableProbeResult({ codec: 'error' }), true)
    assert.equal(isUnreadableProbeResult({ codec: '?' }), true)
    assert.equal(isUnreadableProbeResult({ codec: '' }), true)
    assert.equal(isUnreadableProbeResult(null), true)
    assert.equal(isUnreadableProbeResult({ probeFailed: true, codec: 'unknown' }), true)
    assert.equal(isUnreadableProbeResult({ codec: 'h264' }), false)
    assert.equal(isUnreadableProbeResult({ codec: 'hevc' }), false)
})

test('getVideoInfo returns unreadable placeholder when ffprobe throws', t => {
    const childProcess = require('child_process')
    t.mock.method(childProcess, 'execFileSync', () => {
        const err = new Error('ffprobe exited 1')
        err.status = 1
        err.stderr = [
            '[matroska,webm @ 0x1] 0x00 at pos 0 (0x0) invalid as first byte of an EBML number',
            '[matroska,webm @ 0x1] EBML header parsing failed',
            '/library/bad.mkv: Invalid data found when processing input'
        ].join('\n')
        throw err
    })

    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/broken.mkv', []))
    const info = preGenerator.getVideoInfo('/library/broken.mkv')

    assert.equal(info.codec, 'unreadable')
    assert.equal(info.unreadable, true)
    assert.equal(info.probeFailed, true)
    // codec must not be the word "error" — that used to make Processing lines ship as ERROR
    assert.notEqual(info.codec, 'error')
    assert.match(info.probeError, /Invalid data found when processing input/i)
    assert.equal(info.width, '?')
    assert.equal(info.audioCodec, '?')
})

test('generateVideo skips unreadable media without spawning ffmpeg', async t => {
    const childProcess = require('child_process')
    const logs = []
    let spawnCalls = 0

    t.mock.method(childProcess, 'execFileSync', () => {
        const err = new Error('Command failed: ffprobe')
        err.stderr = 'Invalid data found when processing input\n'
        throw err
    })
    t.mock.method(childProcess, 'spawn', () => {
        spawnCalls += 1
        throw new Error('ffmpeg must not be spawned for unreadable media')
    })

    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

    const filePath = '/library/Saturday Night Live (1975) - s43e13 - Natalie Portman+Dua Lipa.mkv'
    const preGenerator = loadPreGenerator(cacheDir, createDatabase(filePath, []), { logs })
    const channel = { slug: 'late-night', name: 'Late Night' }
    preGenerator.probeVideo = async () => ({ codec: 'unreadable', probeFailed: true, probeError: 'Invalid data found when processing input' })
    const result = await preGenerator.generateVideo(41, filePath, channel)

    assert.deepEqual(result, { skipped: true, reason: 'unreadable' })
    assert.equal(spawnCalls, 0)
    assert.equal(
        logs.some(entry => entry.message.startsWith('Skipping unreadable media ')),
        true,
        'expected a Skipping unreadable media log'
    )
    assert.equal(
        logs.some(entry => entry.message.startsWith('Processing ')),
        false,
        'must not emit Processing line for unreadable media'
    )
    assert.equal(
        logs.some(entry => /Failed to generate|Processing .*\[error/.test(entry.message)),
        false
    )
    const skipLog = logs.find(entry => entry.message.startsWith('Skipping unreadable media '))
    assert.match(skipLog.message, /Saturday Night Live \(1975\) - s43e13 - Natalie Portman\+Dua Lipa\.mkv/)
    assert.doesNotMatch(skipLog.message, /\b(error|failed|unable)\b/i)
    assert.equal(skipLog.context.reason, 'probe_unreadable')
    assert.equal(skipLog.context.level, 'warn')
    assert.match(skipLog.context.probe_error, /Invalid data found when processing input/i)

    // Shipper level for the skip line must be warn, not error (log-monitor noise)
    const { classifyLevel } = require('../Utilities/OrchLogShipper.js')
    assert.equal(classifyLevel(skipLog.message, skipLog.context), 'warn')

    // Permanent unreadable marker so later queueChannel cycles skip this source
    assert.equal(preGenerator.isMarkedUnreadable(filePath, channel.slug), true)
    const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(preGenerator.unreadableMarkerPath(filePath, channel.slug)), 'v2', 'unreadable.json'), 'utf8'))
    assert.equal(marker.reason, 'ffprobe_failed')
})

test('startGeneration does not re-log unreadable media as Skipping failed video', async t => {
    const childProcess = require('child_process')

    t.mock.method(childProcess, 'execFileSync', () => {
        const err = new Error('Command failed: ffprobe')
        err.stderr = 'Invalid data found when processing input\n'
        throw err
    })
    t.mock.method(childProcess, 'spawn', () => {
        throw new Error('ffmpeg must not be spawned')
    })

    const logs = []
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const filePath = '/library/corrupt.mkv'
    const db = createDatabase(filePath, [])
    // Force queue to include this video as not-yet-transcoded
    db.video.transcoded = 0
    const preGenerator = loadPreGenerator(cacheDir, db, { logs })
    const channel = { slug: 'news', name: 'News' }

    preGenerator.channelQueues = [[{
        videoId: db.video.id,
        filePath,
        channel
    }]]
    preGenerator.generationQueue = []
    preGenerator.totalVideos = 0

    await preGenerator.startGeneration()

    assert.equal(
        logs.some(entry => entry.message.startsWith('Skipping unreadable media ')),
        true
    )
    assert.equal(
        logs.some(entry => entry.message.startsWith('Skipping failed video:')),
        false,
        'unreadable media must not double-log as Skipping failed video'
    )
    assert.equal(
        logs.some(entry => entry.message.startsWith('Skipping video after encode exit:')),
        false,
        'probe skips resolve — queue must not log a second encode-exit skip'
    )
})

test('queueChannel skips videos marked unreadable', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

    const filePath = '/library/corrupt.mkv'
    const updates = []
    // Not transcoded — would normally enter the queue.
    const db = createDatabase(filePath, updates)
    db.video.transcoded = 0

    const preGenerator = loadPreGenerator(cacheDir, db)
    const channel = { slug: 'news' }
    const outputDir = path.join(
        cacheDir,
        'channels',
        'news',
        'videos',
        db.video.hash
    )
    preGenerator.markMediaUnreadable(outputDir, filePath, 'ffprobe_failed')

    preGenerator.queueChannel(channel)

    assert.equal(preGenerator.channelQueues.length, 0)
})

test('generateVideo marks invalid-input ffmpeg exit as unreadable and resolves', async t => {
    const childProcess = require('child_process')
    const { EventEmitter } = require('events')
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

    const filePath = '/library/bad.mkv'
    const logs = []
    process.env.CACHE_DIR = cacheDir
    process.env.DIMENSIONS = process.env.DIMENSIONS || '720x480'
    process.env.VIDEO_CODEC = process.env.VIDEO_CODEC || 'libx264'
    process.env.AUDIO_CODEC = process.env.AUDIO_CODEC || 'aac'
    process.env.AUDIO_BITRATE = process.env.AUDIO_BITRATE || '128k'
    process.env.HLS_SEGMENT_LENGTH_SECONDS = process.env.HLS_SEGMENT_LENGTH_SECONDS || '6'

    require.cache[logPath] = {
        id: logPath,
        filename: logPath,
        loaded: true,
        exports: (tag, message, channel, context) => {
            logs.push({ tag, message, channel, context })
        }
    }
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: () => createDatabase(filePath, [])
    }
    delete require.cache[preGeneratorPath]

    t.mock.method(childProcess, 'execFileSync', (cmd, args) => {
        if (cmd === 'ffprobe' && Array.isArray(args) && args.includes('a:0')) return 'aac\n'
        if (cmd === 'ffprobe') return 'h264,yuv420p,1920,1080,8\n'
        if (cmd === 'nvidia-smi') throw new Error('no gpu')
        return ''
    })

    t.mock.method(childProcess, 'spawn', () => {
        const proc = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.kill = () => {}
        process.nextTick(() => {
            proc.stderr.emit(
                'data',
                Buffer.from(
                    '[matroska,webm @ 0x1] EBML header parsing failed\nError opening input: Invalid data found when processing input\n'
                )
            )
            proc.emit('close', 183)
        })
        return proc
    })

    const preGenerator = require(preGeneratorPath)
    const channel = { slug: 'news', name: 'News' }
    preGenerator.probeVideo = async () => ({ codec: 'h264', width: 640, height: 480, pixFmt: 'yuv420p', audioCodec: 'aac' })
    const result = await preGenerator.generateVideo(41, filePath, channel)

    assert.deepEqual(result, { skipped: true, reason: 'unreadable' })
    assert.equal(preGenerator.isMarkedUnreadable(filePath, 'news'), true)
    const skipLog = logs.find(entry => /Skipping unreadable media/.test(entry.message))
    assert.ok(skipLog)
    assert.equal(skipLog.context.level, 'warn')
    assert.equal(logs.some(entry => /Failed to generate|^Error:/.test(entry.message)), false)
})
