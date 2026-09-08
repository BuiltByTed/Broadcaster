const test = require('node:test')
const assert = require('node:assert/strict')
const { describeVideo, groupSchedule } = require('../Utilities/GuideDisplay.js')

const channel = { slug: 'mtv', name: 'MTV', paths: ['/media/Music Videos', '/media/TV/Beavis and Butt-Head (1993) {tvdb-75863}'] }
test('music and Beavis names are derived from configured library roots', () => {
  assert.equal(describeVideo('/media/Music Videos/Artist/Song.mkv', channel.paths).title, 'Music Videos')
  assert.equal(describeVideo('/media/TV/Beavis and Butt-Head (1993) {tvdb-75863}/Season 07/Episode.mkv', channel.paths).title, 'Beavis and Butt-Head')
})
test('short mixed MTV clips form readable blocks without altering playout entries', () => {
  const schedule = Array.from({ length: 12 }, (_, index) => ({
    hash: String(index), filePath: index % 2 ? `${channel.paths[1]}/Season 4/Episode.mkv` : '/media/Music Videos/Song.mkv',
    startTime: index * 300000, endTime: (index + 1) * 300000, duration: 300
  }))
  const original = JSON.stringify(schedule)
  const blocks = groupSchedule(schedule, channel)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].title, 'Music Videos + Beavis and Butt-Head')
  assert.equal(blocks[0].duration, 1800)
  assert.equal(blocks[0].clipCount, 6)
  assert.equal(JSON.stringify(schedule), original)
  assert.equal(blocks.at(-1).endTime, schedule.at(-1).endTime)
  assert.equal(JSON.stringify(blocks).includes('/media/'), false)
})
test('grouping never merges across gaps, full episodes or unrelated programs', () => {
  const entries = [
    { title: 'Show', startTime: 0, endTime: 300000, duration: 300 },
    { title: 'Show', startTime: 310000, endTime: 610000, duration: 300 },
    { title: 'Show', startTime: 610000, endTime: 2410000, duration: 1800 },
    { title: 'Different', startTime: 2410000, endTime: 2710000, duration: 300 }
  ]
  assert.equal(groupSchedule(entries, { slug: 'tv' }).length, 4)
})
