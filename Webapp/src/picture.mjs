// Sample decoded pixels, before CRT filters. Dark scenes cannot establish a crop:
// both bars must be nearly uniform black and meet a bright, stable picture edge.
export function detectPillarbox({ data, width, height }, sourceRatio) {
  if (sourceRatio < 1.55 || sourceRatio > 1.95) return null
  const expected = width * (1 - (4 / 3) / sourceRatio) / 2
  const rows = [0.2, 0.35, 0.5, 0.65, 0.8].map(y => Math.floor(height * y))
  const luminance = (x, y) => {
    const i = (y * width + x) * 4
    return Math.max(data[i], data[i + 1], data[i + 2])
  }
  const edges = []
  for (const y of rows) {
    let left = 0, right = width - 1
    while (left < width / 3 && luminance(left, y) < 22) left++
    while (right > width * 2 / 3 && luminance(right, y) < 22) right--
    if (Math.abs(left - expected) <= 3 && Math.abs(width - right - 1 - expected) <= 3 &&
        luminance(left + 3, y) > 40 && luminance(right - 3, y) > 40) edges.push([left, width - right - 1])
  }
  if (edges.length < 3) return null
  const left = Math.min(...edges.map(edge => edge[0])) / width
  const right = Math.min(...edges.map(edge => edge[1])) / width
  return { left, right }
}

export function watchPicture(video, onPicture) {
  const canvas = document.createElement('canvas')
  canvas.width = 192; canvas.height = 108
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let ratio = 0, confirmed = false, hits = 0, misses = 0
  const reset = () => { ratio = 0; confirmed = false; hits = 0; misses = 0 }
  const inspect = () => {
    if (document.hidden || video.readyState < 2 || !video.videoHeight) return
    const nextRatio = video.videoWidth / video.videoHeight
    if (Math.abs(nextRatio - ratio) > 0.02) {
      reset(); ratio = nextRatio
      onPicture({ aspect: ratio < 1.55 ? '4:3' : '16:9', crop: 1 })
    }
    if (ratio < 1.55 || ratio > 1.95 || !ctx) return
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const bars = detectPillarbox(pixels, ratio)
      if (bars) {
        misses = 0
        if (++hits >= 3 && !confirmed) {
          confirmed = true
          onPicture({ aspect: '4:3', crop: 1 / (1 - bars.left - bars.right) })
        }
      } else {
        hits = 0
        // Only visible content IN the side columns disproves a crop. Fades,
        // titles and dark space shots leave the established frame alone.
        let bright = 0
        for (let y = 20; y < 90; y += 5) for (const x of [8, 16, 176, 184]) {
          const i = (y * 192 + x) * 4
          if (Math.max(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) > 40) bright++
        }
        if (bright > 16 && ++misses >= 3 && confirmed) {
          confirmed = false; misses = 0
          onPicture({ aspect: '16:9', crop: 1 })
        }
      }
    } catch { /* Native cross-origin video can disallow pixel access. */ }
  }
  video.addEventListener('emptied', reset)
  video.addEventListener('resize', inspect)
  video.addEventListener('playing', inspect)
  const timer = setInterval(inspect, 500)
  return () => { clearInterval(timer); video.removeEventListener('emptied', reset); video.removeEventListener('resize', inspect); video.removeEventListener('playing', inspect) }
}
