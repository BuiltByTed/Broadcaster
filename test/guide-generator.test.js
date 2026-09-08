const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('regenerates stale guides after removals or repaired source clocks', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-guide-test-'))
  const databasePath = require.resolve('../Utilities/Database.js')
  const guideGeneratorPath = require.resolve('../Utilities/GuideGenerator.js')
  const originalDatabaseModule = require.cache[databasePath]
  const originalCacheDir = process.env.CACHE_DIR

  const currentPath = '/media/current-video.mp4'
  const currentHash = crypto.createHash('md5').update(currentPath).digest('hex')
  const removedHash = crypto.createHash('md5').update('/media/removed-video.mp4').digest('hex')
  let currentVideos = [{
    file_path: currentPath,
    hash: currentHash,
    duration_seconds: 24 * 60 * 60
  }]
  const database = {
    getChannelVideos: () => currentVideos
  }

  process.env.CACHE_DIR = cacheDir
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: () => database
  }
  delete require.cache[guideGeneratorPath]

  t.after(() => {
    delete require.cache[guideGeneratorPath]
    if (originalDatabaseModule) {
      require.cache[databasePath] = originalDatabaseModule
    } else {
      delete require.cache[databasePath]
    }
    if (originalCacheDir === undefined) {
      delete process.env.CACHE_DIR
    } else {
      process.env.CACHE_DIR = originalCacheDir
    }
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const { GuideGenerator, getPrevious3am } = require('../Utilities/GuideGenerator.js')
  const channel = {
    slug: 'test-channel',
    name: 'Test Channel',
    paths: ['/media']
  }
  const generator = new GuideGenerator(channel)
  const dayStart = getPrevious3am()
  const historyDir = path.join(cacheDir, 'history')
  const guidePath = path.join(historyDir, generator.getGuideFilename(dayStart))
  const staleGuide = {
    version: 2,
    generatedAt: 1,
    dayStart,
    dayEnd: dayStart + (24 * 60 * 60 * 1000),
    channelSlug: channel.slug,
    channelName: channel.name,
    schedule: [{
      hash: removedHash,
      title: 'removed-video.mp4',
      filePath: '/media/removed-video.mp4',
      startTime: dayStart,
      endTime: dayStart + (24 * 60 * 60 * 1000),
      duration: 24 * 60 * 60
    }],
    shuffleState: {
      remaining: [],
      videoCount: 1
    }
  }

  fs.mkdirSync(historyDir, { recursive: true })
  fs.writeFileSync(guidePath, JSON.stringify(staleGuide))

  const activeGuide = generator.getActiveGuide()
  const savedGuide = JSON.parse(fs.readFileSync(guidePath, 'utf8'))

  assert.equal(activeGuide.schedule.length, 1)
  assert.equal(activeGuide.schedule[0].hash, currentHash)
  assert.equal(savedGuide.schedule[0].hash, currentHash)
  assert.notEqual(savedGuide.generatedAt, staleGuide.generatedAt)

  // A corrected video clock must replace the old multi-hour schedule and
  // must not carry its invalid overlap forward from yesterday.
  currentVideos[0].duration_seconds = 3600
  currentVideos[0].cache_version = 2
  const previousDay = new Date(dayStart)
  previousDay.setDate(previousDay.getDate() - 1)
  generator.saveGuide({ ...savedGuide, dayStart: previousDay.getTime(), schedule: [{
    ...savedGuide.schedule[0], startTime: dayStart - 3600000,
    endTime: dayStart + 23 * 3600000
  }] })
  const repairedGuide = new GuideGenerator(channel).getActiveGuide()
  assert.equal(repairedGuide.schedule[0].startTime, dayStart)
  assert.equal(repairedGuide.schedule[0].duration, 3600)
  assert.equal(repairedGuide.schedule[0].cacheVersion, 2)

  currentVideos = []
  fs.writeFileSync(guidePath, JSON.stringify(staleGuide))

  const emptyGenerator = new GuideGenerator(channel)
  const emptyGuide = emptyGenerator.getActiveGuide()
  const savedEmptyGuide = JSON.parse(fs.readFileSync(guidePath, 'utf8'))

  assert.deepEqual(emptyGuide.schedule, [])
  assert.deepEqual(savedEmptyGuide.schedule, [])
  assert.equal(savedEmptyGuide.shuffleState.videoCount, 0)
  assert.equal(emptyGenerator.cachedGuide, emptyGuide)
})
