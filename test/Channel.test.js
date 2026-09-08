const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const databasePath = require.resolve('../Utilities/Database.js')
const logPath = require.resolve('../Utilities/Log.js')
const guideGeneratorPath = require.resolve('../Utilities/GuideGenerator.js')
const playlistManagerPath = require.resolve('../Classes/PlaylistManager.js')

const logs = []
const insertedVideos = []
let cleanupCalls = 0

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: () => ({
    upsertChannel: () => 1,
    insertVideo: (channelId, filePath) => {
      insertedVideos.push(filePath)
      return { changes: 1 }
    },
    deleteRemovedVideos: () => { cleanupCalls++; return [] }
  })
}

require.cache[logPath] = {
  id: logPath,
  filename: logPath,
  loaded: true,
  exports: (tag, message) => {
    logs.push({ tag, message })
  }
}

require.cache[guideGeneratorPath] = {
  id: guideGeneratorPath,
  filename: guideGeneratorPath,
  loaded: true,
  exports: {
    GuideGenerator: class GuideGenerator {
      constructor() {}
    }
  }
}

require.cache[playlistManagerPath] = {
  id: playlistManagerPath,
  filename: playlistManagerPath,
  loaded: true,
  exports: {
    PlaylistManager: class PlaylistManager {
      constructor() {}
      setGuideGenerator() {}
      start() {}
    }
  }
}

process.env.SUPPORTED_FORMATS = process.env.SUPPORTED_FORMATS || 'mp4,mkv,avi'

const { Channel } = require('../Classes/Channel.js')

test('continues scanning remaining paths when one root is missing', () => {
  cleanupCalls = 0
  logs.length = 0
  insertedVideos.length = 0

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-channel-'))
  const goodDir = path.join(root, 'good')
  const missingDir = path.join(root, 'missing-does-not-exist')
  fs.mkdirSync(goodDir)
  const videoPath = path.join(goodDir, 'clip.mp4')
  fs.writeFileSync(videoPath, 'fake')

  assert.doesNotThrow(() => {
    Channel({
      type: 'movies',
      name: 'Mixed Roots',
      slug: 'mixed-roots',
      paths: [missingDir, goodDir]
    })
  })

  assert.equal(insertedVideos.length, 1)
  assert.equal(insertedVideos[0], videoPath)
  assert.equal(cleanupCalls, 0, 'a missing mount must never trigger cache deletion')

  const scanFailure = logs.find(
    entry => entry.tag === 'Channel' && entry.message.includes(`Unable to scan path ${missingDir}`)
  )
  assert.ok(scanFailure, 'expected a log for the missing path')

  const foundGood = logs.find(
    entry => entry.tag === 'Channel' && entry.message.includes(`Found 1 supported files in ${goodDir}`)
  )
  assert.ok(foundGood, 'expected a log for the readable path')

  fs.rmSync(root, { recursive: true, force: true })
})

test('continues scanning when an early path is unreadable', () => {
  logs.length = 0
  insertedVideos.length = 0

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-channel-'))
  const blockedDir = path.join(root, 'blocked')
  const goodDir = path.join(root, 'good')
  fs.mkdirSync(blockedDir, { mode: 0o000 })
  fs.mkdirSync(goodDir)
  const videoPath = path.join(goodDir, 'clip.mp4')
  fs.writeFileSync(videoPath, 'fake')

  try {
    assert.doesNotThrow(() => {
      Channel({
        type: 'movies',
        name: 'Blocked Root',
        slug: 'blocked-root',
        paths: [blockedDir, goodDir]
      })
    })

    assert.equal(insertedVideos.length, 1)
    assert.equal(insertedVideos[0], videoPath)

    const scanFailure = logs.find(
      entry => entry.tag === 'Channel' && entry.message.includes(`Unable to scan path ${blockedDir}`)
    )
    // On some environments (e.g. root) mode 0o000 may still be readable; missing-path
    // case above is the primary regression. Accept either skip-or-scan for blocked.
    if (scanFailure) {
      assert.ok(true)
    } else {
      // If unreadable chmod had no effect, both paths were scanned without throw.
      assert.ok(insertedVideos.includes(videoPath))
    }
  } finally {
    fs.chmodSync(blockedDir, 0o755)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects channel slugs that can escape cache directories', () => {
  for (const slug of ['../outside', '.', '__proto__', 'static', 'bad/name']) {
    assert.throws(() => new Channel({ slug, name: 'Unsafe', paths: ['/media'] }))
  }
})

test('scanning terminates when directory symlinks form a cycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-symlink-'))
  fs.writeFileSync(path.join(root, 'video.mp4'), 'test')
  fs.symlinkSync(root, path.join(root, 'loop'))
  insertedVideos.length = 0
  try {
    new Channel({ slug: 'cycle', name: 'Cycle', type: 'shuffle', paths: [root] })
    assert.equal(insertedVideos.length, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
