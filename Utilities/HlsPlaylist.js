// Parse the encoder's VOD playlist once; retain the actual filenames and durations.
function parseHlsPlaylist(content) {
  const segments = []
  let duration = null
  let offset = 0
  let byteRange = null
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) {
      if (duration !== null) throw new Error('Missing segment URI')
      duration = Number(line.slice(8).split(',')[0])
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid segment duration')
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const match = line.match(/^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/)
      if (!match || byteRange) throw new Error('Invalid byte range')
      byteRange = { length: Number(match[1]), start: match[2] === undefined ? null : Number(match[2]) }
    } else if (line && !line.startsWith('#')) {
      if (duration === null || !/^(segment_\d+|stream)\.ts$/.test(line)) throw new Error('Invalid segment URI')
      if (byteRange) {
        const previous = segments.at(-1)
        if (byteRange.start === null) {
          if (!previous?.byteRange || previous.uri !== line) throw new Error('Missing byte-range offset')
          byteRange.start = previous.byteRange.start + previous.byteRange.length
        }
        if (!Number.isSafeInteger(byteRange.length) || byteRange.length <= 0 ||
            !Number.isSafeInteger(byteRange.start) || byteRange.start < 0 ||
            !Number.isSafeInteger(byteRange.start + byteRange.length)) throw new Error('Invalid byte range')
      }
      segments.push({ duration, uri: line, offset, ...(byteRange ? { byteRange } : {}) })
      offset += duration
      duration = null
      byteRange = null
    }
  }
  if (!segments.length || duration !== null || byteRange !== null) throw new Error('Incomplete media playlist')
  return {
    segments,
    duration: offset,
    maxDuration: segments.reduce((max, segment) => Math.max(max, segment.duration), 0),
    complete: content.split(/\r?\n/).some(line => line.trim() === '#EXT-X-ENDLIST')
  }
}

module.exports = { parseHlsPlaylist }
