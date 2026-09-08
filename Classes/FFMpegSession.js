const Log = require('../Utilities/Log.js')
const { spawn, execFileSync } = require('child_process')
const { CACHE_DIR } = process.env
const tag = 'FFMpegSession'

const { VIDEO_CODEC,
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

function buildFFmpegArgs(file, output, channel) {
    const useGPU = VIDEO_CODEC === 'h264_nvenc' && checkNvidiaGPU()
    const [width, height] = DIMENSIONS.split('x')

    // Base input args with GPU decoding if available
    const inputArgs = useGPU
        ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', file]
        : ['-i', file]

    // Determine video codec and preset based on GPU availability
    let videoCodec = VIDEO_CODEC
    let videoPreset = VIDEO_PRESET
    let videoFilter

    if (useGPU && VIDEO_CODEC === 'h264_nvenc') {
        // NVIDIA GPU encoding settings
        videoCodec = 'h264_nvenc'
        // NVENC presets: p1 (fastest) to p7 (slowest/best quality)
        videoPreset = VIDEO_PRESET || 'p4'
        // Full CUDA filter chain - keeps everything on GPU
        videoFilter = `${deinterlacePrefix(VIDEO_FILTER, true)}scale_cuda=${width}:${height},hwdownload,format=nv12`
    } else if (!useGPU && VIDEO_CODEC === 'h264_nvenc') {
        // Fallback to software encoding if NVENC requested but GPU not available
        videoCodec = 'libx264'
        videoPreset = 'veryfast'
        videoFilter = `${deinterlacePrefix(VIDEO_FILTER, false) || 'yadif,'}scale=${DIMENSIONS}`
        Log(tag, 'GPU requested but not available - falling back to software encoding', channel)
    } else {
        // CPU encoding path — yadif_cuda is not available on CPU, map to yadif
        const cpuFilter = VIDEO_FILTER === 'yadif_cuda' ? 'yadif' : VIDEO_FILTER
        videoFilter = `${cpuFilter ? `${cpuFilter},` : ''}scale=${DIMENSIONS}`
    }

    // Build encoding args
    const encodingArgs = [
        '-vf', videoFilter,
        '-c:v', videoCodec,
        '-preset', videoPreset
    ]

    // Add CRF or quality settings based on codec
    if (videoCodec === 'h264_nvenc') {
        encodingArgs.push('-cq', VIDEO_CRF || '23')
        encodingArgs.push('-rc', 'vbr')
        encodingArgs.push('-rc-lookahead', '20')
        encodingArgs.push('-b:v', '0')  // Use CQ mode
    } else {
        encodingArgs.push('-crf', VIDEO_CRF || '23')
    }

    // Common encoding settings
    encodingArgs.push(
        '-profile:v', 'main',
        '-level', '3.1',
        '-pix_fmt', 'yuv420p',
        '-c:a', AUDIO_CODEC,
        '-b:a', AUDIO_BITRATE,
        '-ac', '2',
        '-hls_time', HLS_SEGMENT_LENGTH_SECONDS,
        '-hls_flags', 'append_list',
        '-hls_start_number_source', 'datetime',
        '-hls_playlist_type', 'event',
        '-f', 'hls',
        output
    )

    return [...inputArgs, ...encodingArgs]
}

function FFMpegSession(channel) {
    const file = channel.queue[channel.currentPlaylistIndex]
    const slug = channel.slug
    const start = Date.now()
    const output = `${CACHE_DIR}/channels/${slug}/_.m3u8`

    const args = buildFFmpegArgs(file, output, channel)

    const ffmpeg = spawn('ffmpeg', args)

    // Log start
    if (channel.currentPlaylistIndex == 0) channel.startTime = Date.now()
    Log(tag, `FFMpeg started encoding ${file}.`, channel)

    let stderrData = ''

    ffmpeg.stdout.on('data', (data) => {
        // FFmpeg outputs to stderr, not stdout
    })

    ffmpeg.stderr.on('data', (data) => {
        stderrData = (stderrData + data.toString()).slice(-32768)
    })

    ffmpeg.on('close', (code) => {
        if (code === 0) {
            channel.currentPlaylistIndex++
            Log(tag, `FFMpeg finished encoding ${file} in ${(Date.now() - start)/1000} seconds.`, channel)
        } else {
            Log(tag, `FFMpeg produced an error (exit code ${code}), so we're skipping to next file.`, channel, { exit_code: code, file, ffmpeg_stderr_tail: stderrData.slice(-500) })
            Log(tag, `Error output: ${stderrData}`, channel)
            channel.currentPlaylistIndex++
            if (channel.segmenter) {
                channel.segmenter.advance()
            }
        }
    })

    ffmpeg.on('error', (err) => {
        Log(tag, `Failed to start FFMpeg: ${err.message}`, channel, { error: err, file, channel_slug: channel && channel.slug })
        channel.currentPlaylistIndex++
        if (channel.segmenter) {
            channel.segmenter.advance()
        }
    })
}

module.exports = {
    FFMpegSession: FFMpegSession,
    deinterlacePrefix
}
