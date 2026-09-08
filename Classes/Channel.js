const Format = require('../Utilities/FormatValidator.js')
const { PlaylistManager } = require('./PlaylistManager.js')
const { GuideGenerator } = require('../Utilities/GuideGenerator.js')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const tag = 'Channel'

// Recursively find all files in a directory
function findFiles(dir, fileList = [], visited = new Set()) {
  const real = fs.realpathSync(dir)
  if (visited.has(real)) return fileList
  visited.add(real)
  for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, file.name)
    const stat = file.isSymbolicLink() ? fs.statSync(filePath) : file
    if (stat.isDirectory()) findFiles(filePath, fileList, visited)
    else if (stat.isFile()) fileList.push(filePath)
  }
  return fileList
}

function Channel(definition) {
  if (!definition || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(definition.slug || '') ||
      ['static', 'static-4x3', '__proto__', 'constructor', 'prototype'].includes(definition.slug)) {
    throw new Error('Channel slug must be a unique URL-safe name')
  }
  if (!Array.isArray(definition.paths) || !definition.paths.length || definition.paths.some(p => typeof p !== 'string' || !p)) {
    throw new Error('Channel paths must be a nonempty array of directories')
  }


  this.type = definition.type
  this.name = definition.name
  this.slug = definition.slug
  this.paths = definition.paths
  this.started = false

  // Scan filesystem for videos
  Log(tag, `Scanning filesystem...`, this)
  const allFiles = []
  let scanComplete = true

  definition.paths.forEach(dirPath => {
    let count = 0
    let files
    try {
      files = findFiles(dirPath)
    } catch (e) {
      scanComplete = false
      Log(tag, `Unable to scan path ${dirPath}: ${e.message}`, this, { error: e, scan_path: dirPath, channel_slug: definition.slug })
      return
    }

    files.forEach(file => {
      if (Format.isSupported(file)) {
        allFiles.push(file)
        count++
      }
    })
    Log(tag, `Found ${count} supported files in ${dirPath}`, this)
  })

  // Register channel and videos in database
  const db = Database()
  const channelId = db.upsertChannel(this.slug, this.name, this.type)

  // Add all videos to database
  let addedCount = 0
  const registerVideos = () => allFiles.forEach(filePath => {
    const hash = crypto.createHash('md5').update(filePath).digest('hex')
    const filename = path.basename(filePath, path.extname(filePath))
    const result = db.insertVideo(channelId, filePath, hash, filename)
    if (result.changes > 0) {
      addedCount++
    }
  })

  if (db.db?.transaction) db.db.transaction(registerVideos)()
  else registerVideos()

  // Clean up videos that are no longer on disk
  const deletedHashes = scanComplete && allFiles.length > 0 ? db.deleteRemovedVideos(this.slug, allFiles) : []
  if (!scanComplete) Log(tag, 'Keeping cached library because a media path could not be scanned', this)
  if (deletedHashes.length > 0) {
    Log(tag, `Removed ${deletedHashes.length} videos from database that are no longer on disk`, this)
  }

  if (addedCount > 0) {
    Log(tag, `Added ${addedCount} new videos to database`, this)
  }

  // Initialize guide generator (handles schedule creation)
  this.guideGenerator = new GuideGenerator(this)

  // Initialize playlist manager (serves HLS playlists based on guide)
  this.playlistManager = new PlaylistManager(this)
  this.playlistManager.setGuideGenerator(this.guideGenerator)

  // Start method
  this.start = () => {
    if (this.started) return
    this.started = true
    // Ensure guide exists for today (will load from history or generate new)
    this.guideGenerator.ensureGuideExists()
    this.playlistManager.start()
    Log(tag, 'Channel started', this)
  }

  // Get current playlist (delegates to PlaylistManager which uses GuideGenerator)
  this.getPlaylist = () => {
    if (!this.started) return null
    return this.playlistManager.createRollingPlaylist()
  }

  Log(tag, `Finished initializing ${definition.type} channel "${definition.name}" with ${allFiles.length} supported videos.`, this)

}

module.exports = {
  Channel: Channel
}
