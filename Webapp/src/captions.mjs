const timestamp = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0)
export function parseCaptions(vtt) {
  return vtt.replace(/\r/g, '').split(/\n\s*\n/).flatMap(block => {
    const lines = block.trim().split('\n')
    const index = lines.findIndex(line => line.includes(' --> '))
    if (index < 0) return []
    const [from, to] = lines[index].split(' --> ')
    const start = timestamp(from.trim()), end = timestamp(to.trim().split(/\s/)[0])
    const text = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    return Number.isFinite(start) && end > start && text ? [{ start, end, text }] : []
  }).sort((a, b) => a.start - b.start)
}

export function activeCaption(cues, time) {
  let low = 0, high = cues.length
  while (low < high) { const mid = (low + high) >>> 1; if (cues[mid].start <= time) low = mid + 1; else high = mid }
  const active = []
  for (let i = low - 1; i >= 0 && i >= low - 8; i--) if (cues[i].end > time) active.unshift(cues[i].text)
  return active.join('\n')
}
