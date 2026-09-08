// Repair only when the frame count independently agrees with the audio clock.
// A long video and short audio track alone do not prove broken timestamps.
function streamDuration(stream) {
    const direct = Number(stream?.duration)
    if (direct > 0 && Number.isFinite(direct)) return direct
    const match = String(stream?.tags?.DURATION || '').match(/^(\d+):(\d+):([\d.]+)$/)
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null
}

function timingCandidate(video, audio) {
    const videoDuration = streamDuration(video)
    const audioDuration = streamDuration(audio)
    const parts = String(video?.r_frame_rate || '').split('/').map(Number)
    const fps = parts[0] / parts[1]
    if (!(fps >= 10 && fps <= 120 && audioDuration > 1 && videoDuration > audioDuration * 4)) return null
    return { fps, audioDuration, videoDuration }
}

function confirmTimingRepair(candidate, packetCount) {
    const count = Number(packetCount)
    if (!candidate || !Number.isSafeInteger(count) || count <= 0) return null
    const duration = count / candidate.fps
    return Math.abs(duration - candidate.audioDuration) <= Math.max(1, candidate.audioDuration * 0.01)
        ? { fps: candidate.fps, duration } : null
}

module.exports = { streamDuration, timingCandidate, confirmTimingRepair }
