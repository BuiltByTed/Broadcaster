const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.TZ = 'America/New_York'
process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-guide-'))

const databasePath = require.resolve('../Utilities/Database.js')
let videos = []
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: () => ({
    getChannelVideos: () => videos
  })
}

const {
  GuideGenerator,
  getNext3am
} = require('../Utilities/GuideGenerator.js')

test.after(() => {
  fs.rmSync(process.env.CACHE_DIR, { recursive: true, force: true })
})

function local3am(year, month, day) {
  return new Date(year, month, day, 3, 0, 0, 0).getTime()
}

test('carries an entry that overlaps the 3am boundary into the new guide', () => {
  const dayStart = new Date(2026, 0, 15, 3, 0, 0, 0).getTime()
  const overlappingEntry = {
    hash: 'previous-video',
    title: 'Previous show',
    filePath: '/media/previous.mp4',
    startTime: dayStart - (2 * 60 * 60 * 1000),
    endTime: dayStart + (2 * 60 * 60 * 1000),
    duration: 4 * 60 * 60
  }
  const generator = new GuideGenerator({
    slug: 'test-channel',
    name: 'Test Channel',
    paths: ['/media']
  })

  videos = [{
    file_path: '/media/next.mp4',
    duration_seconds: 60 * 60
  }, { file_path: '/media/previous.mp4', duration_seconds: 4 * 60 * 60 }]
  generator.loadGuideForDay = requestedDayStart => {
    assert.equal(requestedDayStart, dayStart - (24 * 60 * 60 * 1000))
    return { schedule: [overlappingEntry] }
  }
  generator.saveGuide = () => {}

  const guide = generator.generateDailyGuide(dayStart)

  assert.deepEqual(guide.schedule[0], overlappingEntry)
  assert.notStrictEqual(guide.schedule[0], overlappingEntry)
  assert.equal(guide.schedule[1].startTime, overlappingEntry.endTime)
})

test('finds a previous-guide overlap more than one hour after 3am', () => {
  const dayStart = new Date(2026, 0, 15, 3, 0, 0, 0).getTime()
  const lookupTime = dayStart + (2 * 60 * 60 * 1000)
  const overlappingEntry = {
    hash: 'long-video',
    startTime: dayStart - (30 * 60 * 1000),
    endTime: dayStart + (3 * 60 * 60 * 1000)
  }
  const generator = new GuideGenerator({ slug: 'test-channel' })

  generator.getActiveGuide = () => ({
    dayStart,
    schedule: [{
      hash: 'next-video',
      startTime: overlappingEntry.endTime,
      endTime: overlappingEntry.endTime + (60 * 60 * 1000)
    }]
  })
  generator.loadGuideForDay = requestedDayStart => {
    assert.equal(requestedDayStart, dayStart - (24 * 60 * 60 * 1000))
    return { schedule: [overlappingEntry] }
  }

  assert.equal(generator.findEntryAtTime(lookupTime), overlappingEntry)
})

test('next 3am follows the local calendar across DST transitions', () => {
  const cases = [
    {
      name: 'regular day',
      start: local3am(2025, 0, 15),
      end: local3am(2025, 0, 16),
      hours: 24
    },
    {
      name: 'fall-back day',
      start: local3am(2025, 10, 1),
      end: local3am(2025, 10, 2),
      hours: 25
    },
    {
      name: 'spring-forward day',
      start: local3am(2025, 2, 8),
      end: local3am(2025, 2, 9),
      hours: 23
    }
  ]

  for (const { name, start, end, hours } of cases) {
    assert.equal(getNext3am(start), end, name)
    assert.equal((end - start) / (60 * 60 * 1000), hours, name)
  }
})

test('generated and empty guides end at the next local 3am', () => {
  const dayStart = local3am(2025, 10, 1)
  const expectedDayEnd = local3am(2025, 10, 2)
  const generator = new GuideGenerator({ slug: 'test', name: 'Test' })

  videos = []
  const emptyGuide = generator.generateDailyGuide(dayStart)
  assert.equal(emptyGuide.dayEnd, expectedDayEnd)

  videos = [{ file_path: '/shows/example.mp4', duration_seconds: 60 * 60 }]
  generator.loadGuideForDay = () => null
  generator.saveGuide = () => {}
  const generatedGuide = generator.generateDailyGuide(dayStart)

  assert.equal(generatedGuide.dayEnd, expectedDayEnd)
  assert.ok(generatedGuide.schedule.at(-1).endTime >= expectedDayEnd)
  assert.ok(generatedGuide.schedule.some(entry =>
    entry.startTime <= expectedDayEnd - (30 * 60 * 1000) &&
    entry.endTime > expectedDayEnd - (30 * 60 * 1000)
  ))
})

test('generation loads the previous local-calendar guide', () => {
  const dayStart = local3am(2025, 10, 2)
  const expectedPreviousStart = local3am(2025, 10, 1)
  const generator = new GuideGenerator({ slug: 'test', name: 'Test' })
  let loadedDayStart

  videos = [{ file_path: '/shows/example.mp4', duration_seconds: 60 * 60 }]
  generator.loadGuideForDay = candidate => {
    loadedDayStart = candidate
    return null
  }
  generator.saveGuide = () => {}
  generator.generateDailyGuide(dayStart)

  assert.equal(loadedDayStart, expectedPreviousStart)
})

test('entry lookup checks the previous local-calendar guide', () => {
  const todayStart = local3am(2025, 10, 2)
  const expectedPreviousStart = local3am(2025, 10, 1)
  const generator = new GuideGenerator({ slug: 'test', name: 'Test' })
  let loadedDayStart

  generator.getActiveGuide = () => ({ schedule: [] })
  generator.loadGuideForDay = candidate => {
    loadedDayStart = candidate
    return { schedule: [] }
  }

  assert.equal(generator.findEntryAtTime(todayStart + (15 * 60 * 1000)), null)
  assert.equal(loadedDayStart, expectedPreviousStart)
})

test('uses the first folder beneath a configured root for nested media', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'tv')]
  })
  const filePath = path.join(
    path.sep,
    'media',
    'tv',
    'Star Trek Picard',
    'Season 1',
    'Episode 1.mkv'
  )

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'Star Trek Picard')
})

test('uses the filename for media directly beneath a configured root', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'movies')]
  })
  const filePath = path.join(path.sep, 'media', 'movies', 'Dune.mkv')

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'Dune')
})

test('does not treat a sibling path with the same prefix as configured content', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'tv')]
  })
  const filePath = path.join(
    path.sep,
    'media',
    'tv-archive',
    'Fringe',
    'Episode 1.mkv'
  )

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'Fringe')
})

test('keeps the parent-folder fallback outside configured roots', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'tv')]
  })
  const filePath = path.join(
    path.sep,
    'other',
    'The Expanse',
    'Episode 1.mkv'
  )

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'The Expanse')
})

test('channel type controls ordering across library repeats', (t) => {
  t.mock.method(Math, 'random', () => 0)

  // Reverse of path order — simulates DB insert order from unsorted readdir
  videos = [
    { file_path: '/media/Episode 03.mkv', duration_seconds: 4 * 60 * 60 },
    { file_path: '/media/Episode 01.mkv', duration_seconds: 4 * 60 * 60 },
    { file_path: '/media/Episode 02.mkv', duration_seconds: 4 * 60 * 60 }
  ]

  const dayStart = local3am(2026, 6, 28)

  const generator = new GuideGenerator({
    type: 'alphabetical',
    slug: 'alphabetical',
    name: 'Alphabetical',
    paths: ['/media']
  })
  generator.loadGuideForDay = () => null
  generator.saveGuide = () => {}
  const guide = generator.generateDailyGuide(dayStart)

  assert.deepEqual(
    guide.schedule.map(entry => entry.filePath),
    [
      '/media/Episode 01.mkv',
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv',
      '/media/Episode 01.mkv',
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv'
    ]
  )

  // Fixed order for deterministic Fisher-Yates with Math.random === 0
  videos = [
    { file_path: '/media/Episode 01.mkv', duration_seconds: 4 * 60 * 60 },
    { file_path: '/media/Episode 02.mkv', duration_seconds: 4 * 60 * 60 },
    { file_path: '/media/Episode 03.mkv', duration_seconds: 4 * 60 * 60 }
  ]

  const shuffleGenerator = new GuideGenerator({
    type: 'shuffle',
    slug: 'shuffle',
    name: 'Shuffle',
    paths: ['/media']
  })
  shuffleGenerator.loadGuideForDay = () => null
  shuffleGenerator.saveGuide = () => {}
  const shuffleGuide = shuffleGenerator.generateDailyGuide(dayStart)

  assert.deepEqual(
    shuffleGuide.schedule.map(entry => entry.filePath),
    [
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv',
      '/media/Episode 01.mkv',
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv',
      '/media/Episode 01.mkv'
    ]
  )
})

test('returns an empty guide when every transcoded video has an unusable duration', () => {
  const dayStart = local3am(2026, 0, 1)
  const generator = new GuideGenerator({
    slug: 'test-channel',
    name: 'Test Channel',
    paths: ['/library']
  })
  videos = [
    { file_path: '/library/null.mp4', duration_seconds: null },
    { file_path: '/library/zero.mp4', duration_seconds: 0 },
    { file_path: '/library/negative.mp4', duration_seconds: -1 }
  ]
  generator.loadGuideForDay = () => null
  generator.saveGuide = () => {}

  const guide = generator.generateDailyGuide(dayStart)

  assert.deepEqual(guide.schedule, [])
  assert.deepEqual(guide.shuffleState, { remaining: [], videoCount: 0 })
})

test('excludes unusable durations before scheduling a mixed library', () => {
  const dayStart = local3am(2026, 0, 1)
  const generator = new GuideGenerator({
    slug: 'test-channel',
    name: 'Test Channel',
    paths: ['/library']
  })
  videos = [
    { file_path: '/library/valid.mp4', duration_seconds: 86400 },
    { file_path: '/library/null.mp4', duration_seconds: null },
    { file_path: '/library/zero.mp4', duration_seconds: 0 }
  ]
  generator.loadGuideForDay = () => null
  generator.saveGuide = () => {}

  const guide = generator.generateDailyGuide(dayStart)

  assert.equal(guide.schedule.length, 1)
  assert.equal(guide.schedule[0].filePath, '/library/valid.mp4')
  assert.equal(guide.schedule[0].duration, 86400)
  assert.deepEqual(guide.shuffleState, { remaining: [], videoCount: 1 })
})

test('validation ignores zero-duration rows when comparing library size', () => {
  const crypto = require('node:crypto')
  const dayStart = local3am(2026, 0, 1)
  const validPath = '/library/valid.mp4'
  const validHash = crypto.createHash('md5').update(validPath).digest('hex')
  const generator = new GuideGenerator({
    slug: 'test-channel',
    name: 'Test Channel',
    paths: ['/library']
  })
  videos = [
    { file_path: validPath, duration_seconds: 86400 },
    { file_path: '/library/zero.mp4', duration_seconds: 0 },
    { file_path: '/library/null.mp4', duration_seconds: null }
  ]

  const guide = {
    version: 2,
    generatedAt: Date.now(),
    dayStart,
    dayEnd: dayStart + (24 * 60 * 60 * 1000),
    channelSlug: 'test-channel',
    channelName: 'Test Channel',
    schedule: [{
      hash: validHash,
      title: 'valid.mp4',
      filePath: validPath,
      startTime: dayStart,
      endTime: dayStart + (24 * 60 * 60 * 1000),
      duration: 86400
    }],
    shuffleState: {
      remaining: [],
      videoCount: 1
    }
  }

  assert.equal(generator.getGuideValidationError(guide), null)
})


test('a removed program from yesterday cannot create an unplayable overlap', () => {
  const dayStart = local3am(2026, 0, 16)
  const generator = new GuideGenerator({ slug: 'removed-overlap', name: 'Test' })
  videos = [{ file_path: '/media/available.mp4', duration_seconds: 3600 }]
  generator.loadGuideForDay = () => ({ schedule: [{ hash: 'removed', filePath: '/media/removed.mp4',
    startTime: dayStart - 3600000, endTime: dayStart + 3600000, duration: 7200 }] })
  generator.saveGuide = () => {}
  const guide = generator.generateDailyGuide(dayStart)
  assert.equal(guide.schedule[0].startTime, dayStart)
  assert.equal(guide.schedule.some(entry => entry.hash === 'removed'), false)
})
