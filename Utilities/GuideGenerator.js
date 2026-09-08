const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('./Log.js')
const Database = require('./Database.js')
const { describeVideo, groupSchedule } = require('./GuideDisplay.js')
const tag = 'GuideGenerator'
const { CACHE_DIR } = process.env

// Normal cache upgrades preserve on-air timing. A repaired clock can change
// duration by hours and must not retain the invalid legacy schedule.
function hasRepairedTiming(entry, video) {
  return video && (video.cache_version || 0) > (entry.cacheVersion || 0) &&
    Math.abs(video.duration_seconds - entry.duration) > Math.max(2, entry.duration * 0.05)
}

// Fisher-Yates shuffle for uniform randomization
function shuffleArray(array) {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// Get the previous 3am boundary
function getPrevious3am(fromTime = Date.now()) {
  const date = new Date(fromTime)
  date.setHours(3, 0, 0, 0)
  if (new Date(fromTime).getHours() < 3) {
    date.setDate(date.getDate() - 1)
  }
  return date.getTime()
}

// Get the next 3am boundary
function getNext3am(fromTime = Date.now()) {
  const date = new Date(fromTime)
  date.setHours(3, 0, 0, 0)
  if (new Date(fromTime).getHours() >= 3) {
    date.setDate(date.getDate() + 1)
  }
  return date.getTime()
}

// Get the 3am boundary for the previous local-calendar day
function getPreviousDay3am(dayStart) {
  const date = new Date(dayStart)
  date.setDate(date.getDate() - 1)
  date.setHours(3, 0, 0, 0)
  return date.getTime()
}

class GuideGenerator {

  constructor(channel) {
    this.channel = channel
    this.cachedGuide = null
    this.dayCache = new Map()
    this.displayCache = new WeakMap()
  }

  // Get path to history folder
  getHistoryDir() {
    return path.join(CACHE_DIR, 'history')
  }

  // Get guide filename for a specific day
  getGuideFilename(dayStart) {
    const date = new Date(dayStart)
    const dateStr = date.toISOString().split('T')[0]
    return `guide-${this.channel.slug}-${dateStr}.json`
  }

  // Check that a saved guide still matches the channel's transcoded library
  getGuideValidationError(guide, historical = false) {
    if (!guide || !Array.isArray(guide.schedule)) {
      return 'guide data is malformed'
    }

    if (guide.schedule.some((entry, index) => !entry || !Number.isFinite(entry.startTime) ||
        !Number.isFinite(entry.endTime) || entry.endTime <= entry.startTime ||
        !Number.isFinite(entry.duration) || entry.duration <= 0 ||
        (index > 0 && Math.abs(guide.schedule[index - 1].endTime - entry.startTime) > 1))) {
      return 'guide timeline is malformed'
    }
    if (historical) return null
    const db = Database()
    // Match generateDailyGuide: only count videos with a finite positive duration
    // so zero-duration rows do not permanently mark guides stale.
    const videos = db.getChannelVideos(this.channel.slug, true).filter(video =>
      Number.isFinite(video.duration_seconds) && video.duration_seconds > 0
    )
    const currentHashes = new Set(videos.map(video =>
      crypto.createHash('md5').update(video.file_path).digest('hex')
    ))

    const missingEntry = guide.schedule.find(entry => !currentHashes.has(entry.hash))
    if (missingEntry) {
      return `scheduled video ${missingEntry.hash} is no longer available`
    }

    const videosByHash = new Map(videos.map(video => [video.hash || crypto.createHash('md5').update(video.file_path).digest('hex'), video]))
    if (guide.schedule.some(entry => hasRepairedTiming(entry, videosByHash.get(entry.hash)))) {
      return 'scheduled video duration was repaired'
    }

    const savedVideoCount = guide.shuffleState && guide.shuffleState.videoCount
    // Newly transcoded videos join the next day; never reshuffle an on-air guide.
    if (guide.schedule.length === 0 && videos.length > 0) {
      return `library size changed from ${savedVideoCount ?? 'unknown'} to ${videos.length}`
    }

    return null
  }

  // Load guide from history for a specific day
  loadGuideForDay(dayStart) {
    if (this.dayCache.has(dayStart)) return this.dayCache.get(dayStart)
    const historyDir = this.getHistoryDir()
    const filename = this.getGuideFilename(dayStart)
    const filePath = path.join(historyDir, filename)

    try {
      if (fs.existsSync(filePath)) {
        const guide = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        const validationError = this.getGuideValidationError(guide, dayStart < getPrevious3am())
        if (validationError) {
          Log(tag, `Ignoring stale ${filename}: ${validationError}`, this.channel)
          return null
        }
        Log(tag, `Loaded guide from ${filename}`, this.channel)
        this.rememberGuide(guide)
        return guide
      }
    } catch (err) {
      Log(tag, `Error loading guide: ${err.message}`, this.channel, { error: err, guide_path: filePath })
    }
    return null
  }

  // Save guide to history folder
  saveGuide(guide) {
    const historyDir = this.getHistoryDir()
    fs.mkdirSync(historyDir, { recursive: true })

    const filename = this.getGuideFilename(guide.dayStart)
    const filePath = path.join(historyDir, filename)

    const temporaryPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(guide))
    fs.renameSync(temporaryPath, filePath)
    this.rememberGuide(guide)
    Log(tag, `Saved guide to ${filename}`, this.channel)
  }

  rememberGuide(guide) {
    this.dayCache.set(guide.dayStart, guide)
    while (this.dayCache.size > 4) this.dayCache.delete(this.dayCache.keys().next().value)
  }

  getGuideForDay(dayStart) {
    return this.loadGuideForDay(dayStart) || this.generateDailyGuide(dayStart)
  }

  getVideoDisplayName(filePath) {
    return describeVideo(filePath, this.channel.paths).title
  }

  // Generate a new daily guide
  generateDailyGuide(dayStart = null) {
    if (!dayStart) {
      dayStart = getPrevious3am()
    }

    const dayEnd = getNext3am(dayStart)

    // Get all transcoded videos from database
    const db = Database()
    const videos = db.getChannelVideos(this.channel.slug, true).filter(video =>
      Number.isFinite(video.duration_seconds) && video.duration_seconds > 0
    )

    if (videos.length === 0) {
      Log(tag, `No transcoded videos with positive duration available`, this.channel)
      const guide = this.createEmptyGuide(dayStart)
      this.saveGuide(guide)
      if (guide.dayStart === getPrevious3am()) this.cachedGuide = guide
      return guide
    }

    // Calculate total library duration
    const totalLibraryDuration = videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0)
    const dayDurationSeconds = (dayEnd - dayStart) / 1000

    Log(tag, `Generating guide: ${videos.length} videos, ${Math.round(totalLibraryDuration / 3600)}h library for ${dayDurationSeconds / 3600}h day`, this.channel)

    // Check if previous day's last video extends past dayStart
    let scheduleStart = dayStart
    let overlappingEntry = null
    const prevDayStart = getPreviousDay3am(dayStart)
    const prevGuide = this.loadGuideForDay(prevDayStart)

    if (prevGuide && prevGuide.schedule && prevGuide.schedule.length > 0) {
      const lastEntry = prevGuide.schedule[prevGuide.schedule.length - 1]
      if (lastEntry.endTime > dayStart && videos.some(video => video.file_path === lastEntry.filePath && !hasRepairedTiming(lastEntry, video))) {
        scheduleStart = lastEntry.endTime
        overlappingEntry = lastEntry
        Log(tag, `Previous video extends ${Math.round((lastEntry.endTime - dayStart) / 1000)}s past 3am`, this.channel)
      }
    }

    // Build schedule
    const schedule = overlappingEntry ? [{ ...overlappingEntry }] : []
    let currentTime = scheduleStart
    const shouldShuffle = this.channel.type !== 'alphabetical'
    // Alphabetical must follow path/filename order, not DB insert id (readdir is unsorted).
    const libraryVideos = shouldShuffle
      ? videos
      : [...videos].sort((a, b) =>
        a.file_path.localeCompare(b.file_path, undefined, { sensitivity: 'base' })
      )
    const byHash = new Map(libraryVideos.map(video => [crypto.createHash('md5').update(video.file_path).digest('hex'), video]))
    const remaining = (prevGuide?.shuffleState?.remaining || []).map(hash => byHash.get(hash)).filter(Boolean)
    let scheduledVideos = remaining.length ? remaining : (shouldShuffle ? shuffleArray(libraryVideos) : libraryVideos)
    let videoIndex = 0

    while (currentTime < dayEnd) {
      // If we've used all videos, start the next library pass
      if (videoIndex >= scheduledVideos.length) {
        if (totalLibraryDuration >= dayDurationSeconds) {
          // Library is big enough, shouldn't need repeats - but just in case
          Log(tag, `Restarting video sequence (unexpected - library should cover guide interval)`, this.channel)
        }
        scheduledVideos = shouldShuffle ? shuffleArray(libraryVideos) : libraryVideos
        videoIndex = 0
      }

      const video = scheduledVideos[videoIndex]
      const duration = video.duration_seconds

      const hash = crypto.createHash('md5').update(video.file_path).digest('hex')

      schedule.push({
        hash: hash,
        title: this.getVideoDisplayName(video.file_path),
        filePath: video.file_path,
        startTime: currentTime,
        endTime: currentTime + (duration * 1000),
        duration: duration,
        segmentCount: video.segment_count,
        cacheVersion: video.cache_version || 0
      })

      currentTime += duration * 1000
      videoIndex++
    }

    // Store remaining shuffle state for next day's continuity
    const remainingHashes = scheduledVideos.slice(videoIndex).map(v =>
      crypto.createHash('md5').update(v.file_path).digest('hex')
    )

    const guide = {
      version: 3,
      generatedAt: Date.now(),
      dayStart: dayStart,
      dayEnd: dayEnd,
      channelSlug: this.channel.slug,
      channelName: this.channel.name,
      schedule: schedule,
      shuffleState: {
        remaining: remainingHashes,
        videoCount: videos.length
      }
    }

    this.saveGuide(guide)
    if (guide.dayStart === getPrevious3am()) this.cachedGuide = guide

    Log(tag, `Generated guide with ${schedule.length} entries`, this.channel)
    return guide
  }

  // Create empty guide for channels with no content
  createEmptyGuide(dayStart) {
    return {
      version: 3,
      generatedAt: Date.now(),
      dayStart: dayStart,
      dayEnd: getNext3am(dayStart),
      channelSlug: this.channel.slug,
      channelName: this.channel.name,
      schedule: [],
      shuffleState: { remaining: [], videoCount: 0 }
    }
  }

  // Get the currently active guide (handles day boundaries)
  getActiveGuide() {
    const now = Date.now()
    const todayStart = getPrevious3am(now)

    // Check cache first
    if (this.cachedGuide && this.cachedGuide.dayStart === todayStart) {
      return this.cachedGuide
    }

    // Try to load today's guide
    let guide = this.loadGuideForDay(todayStart)

    if (guide) {
      if (guide.dayStart === getPrevious3am()) this.cachedGuide = guide
      return guide
    }

    // No guide exists, generate one
    Log(tag, `No guide for today, generating...`, this.channel)
    guide = this.generateDailyGuide(todayStart)
    return guide
  }

  // Ensure a guide exists for today (called on channel start)
  ensureGuideExists() {
    return this.getActiveGuide()
  }

  // Find the schedule entry for a specific time
  findEntryAtTime(time = Date.now()) {
    const guide = this.getActiveGuide()
    if (!guide || !guide.schedule) return null

    // First check today's guide
    let entry = guide.schedule.find(e => e.startTime <= time && e.endTime > time)
    if (entry) return entry

    // Check the previous day for guides generated before overlapping entries
    // were carried forward. The overlap can last longer than one hour.
    const todayStart = getPrevious3am(time)
    const prevDayStart = getPreviousDay3am(todayStart)
    const prevGuide = this.loadGuideForDay(prevDayStart)
    if (prevGuide && prevGuide.schedule) {
      entry = prevGuide.schedule.find(e => e.startTime <= time && e.endTime > time)
      if (entry) return entry
    }

    return null
  }

  // Get schedule for API (returns schedule array with isCurrent flag)
  getScheduleForAPI() {
    const guide = this.getActiveGuide()
    if (!guide || !guide.schedule) return []

    const now = Date.now()

    return guide.schedule.map(entry => ({
      hash: entry.hash,
      ...describeVideo(entry.filePath || entry.title, this.channel.paths),
      startTime: entry.startTime,
      endTime: entry.endTime,
      duration: entry.duration,
      isCurrent: entry.startTime <= now && entry.endTime > now
    }))
  }

  getDisplaySchedule() {
    const guide = this.getActiveGuide()
    if (!guide) return []
    if (!this.displayCache.has(guide)) this.displayCache.set(guide, groupSchedule(guide.schedule, this.channel))
    return this.displayCache.get(guide)
  }

  // Invalidate cached guide (call when videos are added/removed)
  invalidateCache() {
    this.cachedGuide = null
    this.dayCache.clear()
  }
}

module.exports = {
  GuideGenerator,
  getPrevious3am,
  getNext3am,
  getPreviousDay3am
}
