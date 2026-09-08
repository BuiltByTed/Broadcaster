// Parse the encoder's VOD playlist once; retain the actual filenames and durations.
function parseHlsPlaylist(content) {
  const segments = []
  let duration = null
  let offset = 0
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) {
      if (duration !== null) throw new Error('Missing segment URI')
      duration = Number(line.slice(8).split(',')[0])
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid segment duration')
    } else if (line && !line.startsWith('#')) {
      if (duration === null || !/^segment_\d+\.ts$/.test(line)) throw new Error('Invalid segment URI')
      segments.push({ duration, uri: line, offset })
      offset += duration
      duration = null
    }
  }
  if (!segments.length || duration !== null) throw new Error('Incomplete media playlist')
  return {
    segments,
    duration: offset,
    maxDuration: segments.reduce((max, segment) => Math.max(max, segment.duration), 0),
    complete: content.split(/\r?\n/).some(line => line.trim() === '#EXT-X-ENDLIST')
  }
}

module.exports = { parseHlsPlaylist }
