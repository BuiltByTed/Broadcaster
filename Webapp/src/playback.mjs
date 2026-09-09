import Hls from 'hls.js'
import { warmLoader } from './channelWarmup.mjs'

// One owner for all player listeners, retries and media resources. A disposed
// session cannot restart a channel the viewer has already left.
export function startPlayback({ video, url, cache, onClock, onPlaying, onStatus, onBlocked }) {
  let disposed = false
  let hls = null
  let retryTimer = null
  let attempts = 0
  let lastProgress = Date.now()
  let lastMediaRecovery = 0
  const isNative = !Hls.isSupported() && video.canPlayType('application/vnd.apple.mpegurl')
  const play = () => video.play().catch(error => {
    if (!disposed && error.name === 'NotAllowedError') onBlocked(true)
  })
  const progress = () => {
    lastProgress = Date.now()
    let date = hls?.playingDate
    try {
      if (!date && typeof video.getStartDate === 'function') date = new Date(video.getStartDate().getTime() + video.currentTime * 1000)
    } catch { /* A native player may not have a timeline until metadata loads. */ }
    if (date && Number.isFinite(date.getTime())) onClock?.(date.getTime())
  }
  const playing = () => {
    progress()
    attempts = 0
    onBlocked(false)
    onStatus('')
    onPlaying()
  }
  const retry = () => {
    if (disposed || retryTimer !== null) return
    onStatus('Reconnecting…')
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (disposed) return
      lastProgress = Date.now()
      load()
    }, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)))
  }
  const load = () => {
    hls?.destroy()
    hls = null
    video.loop = false
    if (Hls.isSupported()) {
      hls = new Hls({
        ...(cache ? { loader: warmLoader(Hls.DefaultConfig.loader, cache) } : {}),
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 32 * 1024 * 1024,
        backBufferLength: 10,
        liveSyncDuration: 30,
        // EXT-X-START selects the actual wall-clock position. Do not jump to
        // the end of a playlist containing pre-encoded future programs.
        liveMaxLatencyDuration: Infinity,
        startFragPrefetch: true
      })
      const player = hls
      player.on(Hls.Events.LEVEL_LOADED, (_, { details }) => {
        // This stream includes future programs. Match recovery seeks to the
        // server's broadcast position, including legacy caches with long GOPs.
        const offset = details.startTimeOffset
        if (details.live && Number.isFinite(offset)) {
          const start = offset < 0 ? details.totalduration + offset : offset
          player.targetLatency = Math.max(1, details.totalduration - start)
        }
      })
      player.on(Hls.Events.MANIFEST_PARSED, () => { if (!disposed && hls === player) play() })
      player.on(Hls.Events.ERROR, (_, data) => {
        if (disposed || hls !== player || !data.fatal) return
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && Date.now() - lastMediaRecovery > 10000) {
          lastMediaRecovery = Date.now()
          player.recoverMediaError()
        } else retry()
      })
      player.loadSource(url)
      player.attachMedia(video)
    } else if (isNative) {
      video.src = url
      video.load()
      play()
    } else onStatus('This browser does not support HLS playback.')
  }
  const online = () => { if (!disposed) retry() }
  video.addEventListener('playing', playing)
  video.addEventListener('timeupdate', progress)
  video.addEventListener('ended', retry)
  video.addEventListener('error', retry)
  window.addEventListener('online', online)
  const watchdog = setInterval(() => {
    if (!disposed && !document.hidden && Date.now() - lastProgress > 15000) retry()
  }, 5000)
  load()
  return () => {
    disposed = true
    clearTimeout(retryTimer)
    clearInterval(watchdog)
    window.removeEventListener('online', online)
    video.removeEventListener('playing', playing)
    video.removeEventListener('timeupdate', progress)
    video.removeEventListener('ended', retry)
    video.removeEventListener('error', retry)
    hls?.destroy()
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}
