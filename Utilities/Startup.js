async function runBackgroundStartup({
  channelPool,
  preGenerator,
  migrateAll,
  backfillDurations,
  log,
  yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve))
}) {
  migrateAll()
  backfillDurations()

  // Invalidate all guide caches so they pick up any backfilled data
  log('Invalidating guide caches after migration...')
  channelPool.queue.forEach(channel => {
    if (channel.guideGenerator) {
      channel.guideGenerator.invalidateCache()
    }
  })

  // Queue channels one at a time without blocking web requests
  log('Checking for pre-generated HLS streams...')
  for (const channel of channelPool.queue) {
    await yieldToEventLoop()
    await (preGenerator.queueChannelAsync ? preGenerator.queueChannelAsync(channel) : preGenerator.queueChannel(channel))
    if (channel.start && !channel.started) channel.start()
  }

  // Channels will play whatever content is ready while transcoding continues
  channelPool.startBroadcast()
  channelPool.setStartupStatus('ready')
  log('Broadcast started - transcoding continues in background')

  Promise.resolve(preGenerator.startGeneration()).then(() => {
    log('All HLS streams ready!')
  }).catch(error => {
    log('Error during pre-generation: ' + error)
  })
}

function scheduleBackgroundStartup(options) {
  const schedule = options.schedule || setImmediate

  schedule(() => {
    runBackgroundStartup(options).catch(error => {
      options.channelPool.setStartupStatus('degraded', error)
      options.log('Background startup failed; service degraded: ' + error)
    })
  })
}

module.exports = {
  runBackgroundStartup,
  scheduleBackgroundStartup
}
