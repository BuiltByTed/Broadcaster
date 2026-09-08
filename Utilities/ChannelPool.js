const Log = require('./Log.js')
const tag = 'ChannelPool'

module.exports = () => {
  return pool
}

class ChannelPool {

  constructor() {
    this.queue = []
    this.startupStatus = {
      state: 'starting',
      error: null
    }
    Log(tag, 'Channel Pool created.')
  }

  addChannel(channel) {
    if (this.getChannelBySlug(channel.slug)) throw new Error(`Duplicate channel slug: ${channel.slug}`)
    this.queue.push(channel)
    Log(tag, 'Added to channel pool.', channel)
  }

  clearChannels() {
    // Stop all channels
    this.queue.forEach(channel => {
      if (channel.stop) {
        channel.stop()
      }
    })
    this.queue = []
    Log(tag, 'Channel pool cleared.')
  }

  getChannelBySlug(slug) {
    return this.queue.find(c => c.slug === slug)
  }

  setStartupStatus(state, error = null) {
    this.startupStatus = {
      state,
      error: error ? String(error.message || error) : null
    }
  }

  getStartupStatus() {
    return { ...this.startupStatus }
  }

  startBroadcast() {
    this.queue.forEach((channel) => {
      channel.start()
    })
  }

}

var pool = new ChannelPool()
