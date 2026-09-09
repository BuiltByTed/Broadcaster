require('dotenv').config({ path: `./config.txt` })
const ChannelPool = require('./Utilities/ChannelPool.js')
const { Channel } = require('./Classes/Channel.js')
const PreGenerator = require('./Utilities/PreGenerator.js')
const { migrateAll, backfillDurations } = require('./Utilities/MigrateDatabase.js')
const Log = require('./Utilities/Log.js')
const { flushOrchLogs } = require('./Utilities/OrchLogShipper.js')
const tag = "Main"
const fs = require('fs')
const path = require('path')
const TelevisionUI = require('./Webapp/TelevisionUI.js')
const { scheduleBackgroundStartup } = require('./Utilities/Startup.js')
const { CACHE_DIR, CHANNEL_LIST } = process.env

// Support both absolute paths (/data/channels.json) and relative paths (./channels.json)
const channelsPath = path.resolve(CHANNEL_LIST || './channels.json')

let uiStarted = false

let shuttingDown = false
const cleanup = () => {
  Log(tag, 'Cleaning up ...')
  try {
    PreGenerator.stopActiveWorkers()
    require('./Utilities/MediaPresentation.js').stop()
  } catch (e) {
    Log(tag, `Error stopping ffmpeg workers: ${e.message}`, undefined, { error: e, phase: 'cleanup' })
  }
  Log(tag, 'Bye now.')
}

const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  if (uiStarted) TelevisionUI().stop()
  cleanup()
  // Ship the buffered tail before exiting; never let a stuck POST block the stop.
  try {
    await Promise.race([
      flushOrchLogs(),
      new Promise(resolve => setTimeout(resolve, 5000))
    ])
  } catch (e) {
    // Shutdown continues regardless of log delivery.
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Load and parse channels.json
function loadChannels() {
  try {
    if (!fs.existsSync(channelsPath)) {
      Log(tag, `No channels.json found at ${channelsPath}, creating default...`)
      const defaultChannels = [
        {
          "type": "shuffle",
          "name": "Example Channel",
          "slug": "example",
          "paths": [
            "/media"
          ]
        }
      ]
      fs.mkdirSync(path.dirname(channelsPath), { recursive: true })
      fs.writeFileSync(channelsPath, JSON.stringify(defaultChannels, null, 2))
      Log(tag, `Created default channels.json. Edit ${CHANNEL_LIST} to configure your channels.`)
    }

    const data = fs.readFileSync(channelsPath)
    const channels = JSON.parse(data)
    if (!Array.isArray(channels)) throw new Error('channels.json must contain an array')
    Log(tag, `Found ${channels.length} channel definition${channels.length > 1 ? 's' : ''}:`)
    return channels
  } catch (e) {
    Log(tag, `Error loading channels.json: ${e.message}`, undefined, { error: e, channels_path: channelsPath })
    return []
  }
}

// Initialize channels from config
function initializeChannels(channelDefinitions, dependencies = {}) {
  const createChannel = dependencies.createChannel || (definition => new Channel(definition))
  const channelPool = dependencies.channelPool || ChannelPool()
  const log = dependencies.log || Log

  channelDefinitions.forEach(definition => {
    try {
      const channel = createChannel(definition)
      channelPool.addChannel(channel)
    } catch (e) {
      const channelName = definition && (definition.name || definition.slug)
      const channelDescription = channelName ? ` "${channelName}"` : ''
      log(tag, `Unable to create channel${channelDescription}: ${e}`)
    }
  })
}

// Startup sequence
async function startup() {
  // Load initial channels
  const channelDefinitions = loadChannels()
  initializeChannels(channelDefinitions)

  // Start UI immediately - don't block on migration!
  try {
    TelevisionUI().start(ChannelPool())
    uiStarted = true
    Log(tag, 'Web UI started and ready')
  } catch (e) {
    Log(tag, `Unable to start the TV UI: ${e.message}`, undefined, { error: e, web_ui_port: process.env.WEB_UI_PORT })
  }

  // Run migration in background (don't block the UI)
  Log(tag, 'Migrating existing transcoded videos to database (background)...')
  scheduleBackgroundStartup({
    channelPool: ChannelPool(),
    preGenerator: PreGenerator,
    migrateAll,
    backfillDurations,
    log: (message) => Log(tag, message)
  })
}

if (require.main === module) {
  startup()
}

module.exports = {
  initializeChannels,
  cleanup
}
