const path = require('path')

function cleanTitle(title) {
  return title.replace(/\s*\{(?:tvdb|tmdb|imdb)-[^}]+\}/gi, '').trim()
}

function describeVideo(filePath, roots = []) {
  const root = [...roots].sort((a, b) => b.length - a.length).find(candidate => {
    const relative = path.relative(candidate, filePath)
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  })
  const rootName = root ? path.basename(root) : ''
  const relative = root ? path.relative(root, filePath).split(path.sep) : []
  let title
  if (/music[ _-]*videos?/i.test(rootName)) title = 'Music Videos'
  else if (/\{(?:tvdb|tmdb|imdb)-/i.test(rootName) || /^season\s*\d+$/i.test(relative[0] || '')) title = rootName
  else if (relative.length > 1) title = relative[0]
  else if (relative.length === 1) title = path.basename(filePath, path.extname(filePath))
  else title = path.basename(path.dirname(filePath))
  title = cleanTitle(title)
  if (/beavis.*butt[ -]*head/i.test(title)) title = 'Beavis and Butt-Head'
  return { title, episodeTitle: path.basename(filePath, path.extname(filePath)) }
}

// Display blocks leave the exact playout schedule untouched. MTV's shuffled clips
// share a half-hour-sized block even when a Beavis short interrupts the music.
function groupSchedule(schedule, channel) {
  const blocks = []
  const isMusicChannel = /\bmtv\b|music/i.test(`${channel.name || ''} ${channel.slug}`)
  for (const entry of schedule) {
    const description = entry.filePath ? describeVideo(entry.filePath, channel.paths) : { title: cleanTitle(entry.title || '') }
    const short = entry.duration < 20 * 60
    const musicBlock = short && isMusicChannel && /^(Music Videos|Beavis and Butt-Head)$/.test(description.title)
    const group = musicBlock ? 'music-variety' : description.title
    const previous = blocks.at(-1)
    if (short && previous?.short && previous.group === group && previous.duration < 30 * 60 && Math.abs(previous.endTime - entry.startTime) < 1) {
      previous.endTime = entry.endTime
      previous.duration = (previous.endTime - previous.startTime) / 1000
      previous.clipCount++
      if (!previous.titles.includes(description.title)) previous.titles.push(description.title)
    } else {
      blocks.push({ hash: entry.hash, title: description.title, startTime: entry.startTime,
        endTime: entry.endTime, duration: entry.duration, clipCount: 1, titles: [description.title], group, short })
    }
  }
  return blocks.map(({ group, short, titles, ...block }) => ({
    ...block,
    title: titles.length > 1 ? 'Music Videos + Beavis and Butt-Head' : block.title
  }))
}

module.exports = { describeVideo, groupSchedule }
