import { useState, useEffect, useRef, useMemo } from 'react'
import { startPlayback } from './playback.mjs'
import StaticNoise from './StaticNoise.jsx'
import { ChannelWarmup } from './channelWarmup.mjs'
import { watchPicture } from './picture.mjs'
import { parseCaptions, activeCaption } from './captions.mjs'
import './App.css'
import { cancelChannelSwitch, scheduleChannelSwitch } from './channelSwitch.mjs'
import {
  CHANNEL_ENTRY_INVALID_MS,
  appendDigit,
  cancelChannelEntry,
  parseChannelNumber,
  resolveChannelIndex,
  scheduleChannelEntryCommit
} from './channelEntry.mjs'
import { showOverlay } from './overlayTimer.mjs'
import {
  removeEndedListener as removeEndedListenerFromRef,
  replaceEndedListener
} from './endedListener.mjs'

// Marquee component that only animates when text is truncated
function MarqueeTitle({ title }) {
  const containerRef = useRef(null)
  const textRef = useRef(null)
  const [overflowAmount, setOverflowAmount] = useState(0)

  useEffect(() => {
    const checkOverflow = () => {
      if (containerRef.current && textRef.current) {
        const overflow = textRef.current.scrollWidth - containerRef.current.clientWidth
        setOverflowAmount(overflow > 0 ? overflow : 0)
      }
    }
    checkOverflow()
    const observer = new ResizeObserver(checkOverflow)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [title])

  return (
    <div className="guide-show-title" ref={containerRef}>
      <span
        ref={textRef}
        className={overflowAmount > 0 ? 'marquee' : ''}
        style={overflowAmount > 0 ? { '--scroll-distance': `-${overflowAmount}px` } : undefined}
      >{title}</span>
    </div>
  )
}

function App() {
  const videoRef = useRef(null)
  const playbackCleanupRef = useRef(null)
  const powerRef = useRef(false)
  const warmupRef = useRef(null)
  if (!warmupRef.current) warmupRef.current = new ChannelWarmup()
  const broadcastTimeRef = useRef(null)
  const pictureRef = useRef(null)
  const pictureWatcherRef = useRef(null)
  const [picture, setPicture] = useState({ aspect: '16:9', crop: 1 })
  const [pictureSize, setPictureSize] = useState({ width: 0, height: 0 })
  const [captionsOn, setCaptionsOn] = useState(() => { try { return localStorage.getItem('tv-captions') === 'on' } catch { return false } })
  const [caption, setCaption] = useState('')
  const [captionStatus, setCaptionStatus] = useState('')
  const serverOffsetRef = useRef(0)
  const channelSwitchTimeoutRef = useRef(null)
  const channelOverlayTimeoutRef = useRef(null)
  const channelEntryTimeoutRef = useRef(null)
  const channelEntryInvalidTimeoutRef = useRef(null)
  const channelEntryBufferRef = useRef('')
  const channelEntryInvalidRef = useRef(false)
  const volumeOverlayTimeoutRef = useRef(null)
  const endedListenerRef = useRef(null)
  const playbackTimeoutRef = useRef(null)
  const guideRef = useRef(null)

  const [channels, setChannels] = useState([])
  const [currentChannelIndex, setCurrentChannelIndex] = useState(-1)
  const [isPoweredOn, setIsPoweredOn] = useState(false)
  const [currentVolume, setCurrentVolume] = useState(1.0)
  const [showStatic, setShowStatic] = useState(false)
  const [playbackStatus, setPlaybackStatus] = useState('')
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [guideViewport, setGuideViewport] = useState({ left: 0, width: 1000 })
  const [showChannelOverlay, setShowChannelOverlay] = useState(false)
  const [channelEntryBuffer, setChannelEntryBuffer] = useState('')
  const [channelEntryInvalid, setChannelEntryInvalid] = useState(false)
  const [showVolumeOverlay, setShowVolumeOverlay] = useState(false)
  const [powerAnimation, setPowerAnimation] = useState(null)
  const [showGuide, setShowGuide] = useState(false)
  const [guideData, setGuideData] = useState({})
  const [aspectRatio, setAspectRatio] = useState(() => {
    try { return localStorage.getItem('tv-aspectMode') || 'auto' } catch { return 'auto' }
  })
  const [scanlines, setScanlines] = useState(() => {
    try { return localStorage.getItem('tv-scanlines') === 'on' } catch { return false }
  })
  const [tvSize, setTvSize] = useState({ width: 0, height: 0 })
  const [currentTime, setCurrentTime] = useState(new Date())
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600)


  const clearPlaybackTimeout = () => {
    if (playbackTimeoutRef.current !== null) {
      clearTimeout(playbackTimeoutRef.current)
      playbackTimeoutRef.current = null
    }
  }

  const removeEndedListener = () => {
    removeEndedListenerFromRef(endedListenerRef)
  }

  const addEndedListener = (video, handler) => {
    replaceEndedListener(endedListenerRef, video, handler)
  }

  const stopPlaybackSession = () => {
    removeEndedListener()

    playbackCleanupRef.current?.()
    playbackCleanupRef.current = null
  }

  const clearChannelEntry = () => {
    cancelChannelEntry(channelEntryTimeoutRef)
    cancelChannelEntry(channelEntryInvalidTimeoutRef)
    channelEntryBufferRef.current = ''
    channelEntryInvalidRef.current = false
    setChannelEntryBuffer('')
    setChannelEntryInvalid(false)
  }

  useEffect(() => {
    return () => {
      cancelChannelSwitch(channelSwitchTimeoutRef)
      cancelChannelEntry(channelEntryTimeoutRef)
      cancelChannelEntry(channelEntryInvalidTimeoutRef)
      clearPlaybackTimeout()
      stopPlaybackSession()
      warmupRef.current.clear()
      clearTimeout(channelOverlayTimeoutRef.current)
      clearTimeout(volumeOverlayTimeoutRef.current)
    }
  }, [])

  const frameAspect = aspectRatio === 'auto' ? picture.aspect : aspectRatio

  useEffect(() => {
    pictureWatcherRef.current = watchPicture(videoRef.current, setPicture)
    return () => pictureWatcherRef.current?.()
  }, [])
  useEffect(() => {
    const element = pictureRef.current.parentElement
    const resize = () => {
      const ratio = frameAspect === '4:3' ? 4 / 3 : 16 / 9
      const width = Math.min(element.clientWidth, element.clientHeight * ratio)
      setPictureSize({ width, height: width / ratio })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [frameAspect])

  useEffect(() => {
    if (!isPoweredOn || !channels.length) { warmupRef.current.clear(); return }
    const indexes = currentChannelIndex < 0 ? [0, channels.length - 1] :
      [(currentChannelIndex + 1) % channels.length, (currentChannelIndex + channels.length - 1) % channels.length]
    return warmupRef.current.follow(indexes.filter(i => i !== currentChannelIndex).map(i => `/${encodeURIComponent(channels[i].slug)}.m3u8`))
  }, [isPoweredOn, currentChannelIndex, channels])

  useEffect(() => {
    try { localStorage.setItem('tv-captions', captionsOn ? 'on' : 'off') } catch {}
    setCaption('')
    setCaptionStatus('')
    if (!captionsOn || !isPoweredOn || currentChannelIndex < 0) return
    const controller = new AbortController()
    let program = null, cues = [], nextCheck = 0, busy = false
    const tick = async () => {
      const clock = broadcastTimeRef.current
      if (!clock || document.hidden || controller.signal.aborted) return
      const time = clock.time + (videoRef.current.paused ? 0 : Math.max(0, videoRef.current.currentTime - clock.mediaTime) * 1000)
      setCaption(program && time >= program.startTime && time < program.endTime ? activeCaption(cues, (time - program.startTime) / 1000) : '')
      if (program && time >= program.endTime) { program = null; cues = []; nextCheck = 0 }
      if (busy || Date.now() < nextCheck) return
      busy = true
      try {
        const slug = encodeURIComponent(channels[currentChannelIndex].slug)
        const res = await fetch(`/api/now-playing/${slug}?at=${Math.round(time)}`, { signal: controller.signal })
        if (!res.ok) throw new Error('Captions unavailable')
        const next = await res.json()
        if (controller.signal.aborted) return
        if (next.id !== program?.id) { cues = []; setCaption(''); program = next }
        if (!cues.length && next.captions?.url) {
          const sub = await fetch(next.captions.url, { signal: controller.signal })
          if (!sub.ok) throw new Error('Captions unavailable')
          cues = parseCaptions(await sub.text())
        }
        if (!controller.signal.aborted) setCaptionStatus(cues.length ? '' : next.captions?.status === 'preparing' ? 'Loading captions' : 'No captions for this program')
        nextCheck = Date.now() + (next.captions?.status === 'preparing' ? 2000 : 5000)
      } catch (error) { if (error.name !== 'AbortError') { setCaptionStatus('Captions unavailable'); nextCheck = Date.now() + 10000 } }
      finally { busy = false }
    }
    const timer = setInterval(tick, 100)
    return () => { controller.abort(); clearInterval(timer) }
  }, [captionsOn, isPoweredOn, currentChannelIndex, channels])

  // Calculate TV size based on window and aspect ratio
  useEffect(() => {
    const calculateSize = () => {
      const padding = 16 * 2 // 1rem = 16px on each side
      const controlsHeight = 80 // approximate height of controls + gap
      const borderWidth = 40 // 20px border on each side

      const availableWidth = Math.max(160, window.innerWidth - padding - borderWidth)
      const availableHeight = Math.max(120, window.innerHeight - padding - controlsHeight - borderWidth)

      const ratio = frameAspect === '4:3' ? 4 / 3 : 16 / 9

      // Calculate dimensions that fit within available space
      let width = availableWidth
      let height = width / ratio

      if (height > availableHeight) {
        height = availableHeight
        width = height * ratio
      }

      // Cap max width
      if (width > 1200) {
        width = 1200
        height = width / ratio
      }

      setTvSize({ width: Math.floor(width), height: Math.floor(height) })
      setIsMobile(window.innerWidth <= 600)
    }

    calculateSize()
    window.addEventListener('resize', calculateSize)
    return () => window.removeEventListener('resize', calculateSize)
  }, [frameAspect])

  useEffect(() => {
    try { localStorage.setItem('tv-aspectMode', aspectRatio) } catch {}
  }, [aspectRatio])

  useEffect(() => {
    try { localStorage.setItem('tv-scanlines', scanlines ? 'on' : 'off') } catch {}
  }, [scanlines])

  // Keep polling: the service can become ready after this page was opened.
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const refresh = async () => {
      try {
        const res = await fetch('/manifest.json', { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error('Channels unavailable')
        const data = await res.json()
        if (Array.isArray(data.channels)) setChannels(previous => {
          // Existing channel numbers stay stable as more channels finish encoding.
          const known = new Set(previous.map(channel => channel.slug))
          const additions = data.channels.filter(channel => !known.has(channel.slug))
          return additions.length ? [...previous, ...additions] : previous
        })
      } catch (error) { if (error.name !== 'AbortError') console.warn(error.message) }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 15000)
    }
    refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])

  // Update clock every second when guide is open
  useEffect(() => {
    if (!showGuide) return
    const interval = setInterval(() => {
      setCurrentTime(new Date(Date.now() + serverOffsetRef.current))
    }, 1000)
    return () => clearInterval(interval)
  }, [showGuide])

  // Change channel
  const changeChannel = (index) => {
    if (index < 0 || index >= channels.length || !isPoweredOn) return

    cancelChannelSwitch(channelSwitchTimeoutRef)

    setCurrentChannelIndex(index)
    const channel = channels[index]

    // Show static during channel change
    setShowStatic(true)

    // Stop current stream (also removes prior ended handlers)
    clearPlaybackTimeout()
    stopPlaybackSession()

    // Update display
    showOverlay(setShowChannelOverlay, channelOverlayTimeoutRef)

    setAutoplayBlocked(false)
    setPlaybackStatus('')
    broadcastTimeRef.current = null
    setCaption('')
    // Brief coalescing only; no artificial half-second pause on every tune.
    scheduleChannelSwitch(channelSwitchTimeoutRef, () => {
      const video = videoRef.current
      if (!video || !powerRef.current) return
      video.volume = currentVolume
      playbackCleanupRef.current = startPlayback({
        video, url: `/${encodeURIComponent(channel.slug)}.m3u8`,
        cache: warmupRef.current,
        onProgram: program => pictureWatcherRef.current?.setProgram(program),
        onClock: time => { broadcastTimeRef.current = { time, mediaTime: video.currentTime } },
        onPlaying: () => setShowStatic(false),
        onStatus: setPlaybackStatus,
        onBlocked: setAutoplayBlocked
      })
    }, 0)
  }

  // Channel navigation
  const channelUp = () => {
    if (!isPoweredOn || channels.length === 0) return
    clearChannelEntry()
    const nextIndex = (currentChannelIndex + 1) % channels.length
    changeChannel(nextIndex)
  }

  const channelDown = () => {
    if (!isPoweredOn || channels.length === 0) return
    clearChannelEntry()
    const prevIndex = currentChannelIndex <= 0 ? channels.length - 1 : currentChannelIndex - 1
    changeChannel(prevIndex)
  }

  const flashInvalidChannelEntry = (displayBuffer) => {
    channelEntryBufferRef.current = displayBuffer
    channelEntryInvalidRef.current = true
    setChannelEntryBuffer(displayBuffer)
    setChannelEntryInvalid(true)
    showOverlay(setShowChannelOverlay, channelOverlayTimeoutRef, CHANNEL_ENTRY_INVALID_MS)
    cancelChannelEntry(channelEntryInvalidTimeoutRef)
    scheduleChannelEntryCommit(
      channelEntryInvalidTimeoutRef,
      () => {
        channelEntryBufferRef.current = ''
        channelEntryInvalidRef.current = false
        setChannelEntryBuffer('')
        setChannelEntryInvalid(false)
      },
      CHANNEL_ENTRY_INVALID_MS
    )
  }

  const commitChannelEntry = (buffer, channelList) => {
    cancelChannelEntry(channelEntryTimeoutRef)
    const channelNumber = parseChannelNumber(buffer)
    const index = resolveChannelIndex(channelNumber, channelList.length)
    channelEntryBufferRef.current = ''
    channelEntryInvalidRef.current = false
    setChannelEntryBuffer('')
    setChannelEntryInvalid(false)
    if (index === null) {
      flashInvalidChannelEntry(buffer)
      return
    }
    changeChannel(index)
  }

  const handleDigitEntry = (digit) => {
    if (!isPoweredOn || channels.length === 0) return
    if (!/^[0-9]$/.test(digit)) return

    cancelChannelEntry(channelEntryInvalidTimeoutRef)
    const base = channelEntryInvalidRef.current ? '' : channelEntryBufferRef.current
    channelEntryInvalidRef.current = false
    setChannelEntryInvalid(false)

    const next = appendDigit(base, digit)
    if (next.length === 0) return

    channelEntryBufferRef.current = next
    setChannelEntryBuffer(next)
    showOverlay(setShowChannelOverlay, channelOverlayTimeoutRef)
    scheduleChannelEntryCommit(channelEntryTimeoutRef, () => {
      commitChannelEntry(channelEntryBufferRef.current, channels)
    })
  }

  // Volume control
  const volumeUp = () => {
    if (!isPoweredOn) return
    const newVolume = Math.min(1.0, currentVolume + 0.1)
    setCurrentVolume(newVolume)
    if (videoRef.current) videoRef.current.volume = newVolume
    showOverlay(setShowVolumeOverlay, volumeOverlayTimeoutRef, 1500)
  }

  const volumeDown = () => {
    if (!isPoweredOn) return
    const newVolume = Math.max(0, currentVolume - 0.1)
    setCurrentVolume(newVolume)
    if (videoRef.current) videoRef.current.volume = newVolume
    showOverlay(setShowVolumeOverlay, volumeOverlayTimeoutRef, 1500)
  }

  // Static is generated locally; it does not consume HLS bandwidth or a decoder.
  const playStaticChannel = () => {
    clearPlaybackTimeout()
    stopPlaybackSession()
    setShowStatic(true)
    setPlaybackStatus('')
  }

  // Power toggle
  const togglePower = () => {
    if (isPoweredOn) {
      // Power off
      powerRef.current = false
      setIsPoweredOn(false)
      setShowGuide(false)
      setAutoplayBlocked(false)
      setPlaybackStatus('')
      setPowerAnimation('power-off')

      clearChannelEntry()
      cancelChannelSwitch(channelSwitchTimeoutRef)
      clearPlaybackTimeout()
      removeEndedListener()
      playbackTimeoutRef.current = setTimeout(() => {
        playbackTimeoutRef.current = null
        stopPlaybackSession()
        if (videoRef.current) videoRef.current.pause()
        setShowStatic(false)
        setCurrentChannelIndex(-1)
      }, 500)
    } else {
      // Power on - play static channel first
      powerRef.current = true
      setIsPoweredOn(true)
      setPowerAnimation('power-on')

      clearPlaybackTimeout()
      playbackTimeoutRef.current = setTimeout(() => {
        playbackTimeoutRef.current = null
        playStaticChannel()
      }, 500)
    }
  }

  // Fullscreen
  const toggleFullscreen = () => {
    const video = videoRef.current
    if (!video) return

    // iOS Safari uses webkitEnterFullscreen on video element
    const screen = video.closest('.video-wrapper')
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else if (screen.requestFullscreen) screen.requestFullscreen().catch(() => {})
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen()
  }

  const toggleGuide = () => {
    if (isPoweredOn) setShowGuide(value => !value)
  }

  useEffect(() => {
    if (!showGuide) return
    const controller = new AbortController()
    let timer
    let initial = true
    const refresh = async () => {
      const sent = Date.now()
      try {
        const res = await fetch('/api/guide?display=1', { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error('Guide unavailable')
        const data = await res.json()
        if (data.serverTime) serverOffsetRef.current = data.serverTime - (sent + Date.now()) / 2
        setGuideData(data)
        setCurrentTime(new Date(Date.now() + serverOffsetRef.current))
        if (initial && data.dayStart) {
          initial = false
          requestAnimationFrame(() => {
            if (controller.signal.aborted || !guideRef.current) return
            const mobile = window.innerWidth <= 600
            guideRef.current.scrollLeft = Math.max(0, (Date.now() + serverOffsetRef.current - data.dayStart) / 60000 * (mobile ? 5 : 10) - (mobile ? 50 : 100))
            setGuideViewport({ left: guideRef.current.scrollLeft, width: guideRef.current.clientWidth })
            channelsRef.current?.querySelector('.guide-channel-name.current')?.scrollIntoView({ block: 'nearest' })
          })
        }
      } catch (error) { if (error.name !== 'AbortError') console.warn(error.message) }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 30000)
    }
    refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [showGuide])

  // Navigate to channel from guide
  const selectChannelFromGuide = (slug) => {
    const index = channels.findIndex(c => c.slug === slug)
    if (index !== -1) {
      setShowGuide(false)
      changeChannel(index)
    }
  }

  // Format time for guide display
  const formatTime = (timestamp) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  // Format duration for guide display
  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    if (mins < 60) return `${mins}m`
    const hours = Math.floor(mins / 60)
    const remainMins = mins % 60
    return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
  }

  // Sync vertical scroll between channel list and schedule
  const channelsRef = useRef(null)
  const handleScheduleScroll = (e) => {
    setGuideViewport({ left: e.target.scrollLeft, width: e.target.clientWidth })
    if (channelsRef.current) {
      channelsRef.current.scrollTop = e.target.scrollTop
    }
  }
  const handleChannelsScroll = (e) => {
    if (guideRef.current) {
      guideRef.current.scrollTop = e.target.scrollTop
    }
  }

  // Handle fullscreen changes - prevent pause on iOS when exiting fullscreen
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleFullscreenChange = () => {
      // When exiting fullscreen, resume playback if it was paused
      if (!document.fullscreenElement && !document.webkitFullscreenElement && isPoweredOn) {
        setTimeout(() => {
          if (video.paused) {
            video.play().catch(err => console.log('Resume after fullscreen blocked:', err))
          }
        }, 100)
      }
    }

    const handleWebkitFullscreenChange = () => {
      // iOS Safari specific - resume when exiting fullscreen
      if (!video.webkitDisplayingFullscreen && isPoweredOn) {
        setTimeout(() => {
          if (video.paused) {
            video.play().catch(err => console.log('Resume after fullscreen blocked:', err))
          }
        }, 100)
      }
    }

    // Listen for fullscreen changes
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    video.addEventListener('webkitendfullscreen', handleWebkitFullscreenChange)
    video.addEventListener('webkitbeginfullscreen', handleWebkitFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
      video.removeEventListener('webkitendfullscreen', handleWebkitFullscreenChange)
      video.removeEventListener('webkitbeginfullscreen', handleWebkitFullscreenChange)
    }
  }, [isPoweredOn])

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return
      if (e.key === 'Escape') { setShowGuide(false); return }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        handleDigitEntry(e.key)
        return
      }

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          channelUp()
          break
        case 'ArrowDown':
          e.preventDefault()
          channelDown()
          break
        case 'ArrowRight':
          e.preventDefault()
          volumeUp()
          break
        case 'ArrowLeft':
          e.preventDefault()
          volumeDown()
          break
        case 'f':
        case 'F':
          toggleFullscreen()
          break
        case 'p':
        case 'P':
          togglePower()
          break
        case 'g':
        case 'G':
          toggleGuide()
          break
        case 'Escape':
          setShowGuide(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isPoweredOn, channels, currentChannelIndex, currentVolume, showGuide])

  const guideChannels = useMemo(() => Object.entries(guideData.channels || {}), [guideData])
  const now = currentTime.getTime()
  const pxPerMinute = isMobile ? 5 : 10
  const guideTicks = []
  if (guideData.dayStart) {
    const firstTick = Math.max(0, Math.floor(guideViewport.left / (30 * pxPerMinute)) - 1)
    const lastTick = Math.ceil((guideViewport.left + guideViewport.width) / (30 * pxPerMinute)) + 1
    for (let tick = firstTick; tick <= lastTick; tick++) {
      const time = guideData.dayStart + tick * 30 * 60000
      if (time <= guideData.dayEnd) guideTicks.push({ time, left: tick * 30 * pxPerMinute })
    }
  }
  const currentChannel = channels[currentChannelIndex]
  const overlayChannelLabel = channelEntryBuffer
    ? channelEntryBuffer
    : String(currentChannelIndex + 1)
  const overlayChannelName = channelEntryBuffer
    ? (channelEntryInvalid ? 'INVALID' : '')
    : (currentChannel?.name.toUpperCase() || 'LOADING...')

  return (
    <div className="tv-container">
      <div className={`video-wrapper ${showGuide ? 'guide-open' : ''}`}>
        <div
          className={`video-content ${powerAnimation || ''} ${scanlines ? 'crt-enabled' : ''}`}
          onAnimationEnd={() => setPowerAnimation(null)}
          style={{ width: tvSize.width, height: tvSize.height }}
        >
          <div className="picture-window" ref={pictureRef} style={pictureSize}>
          <video
            ref={videoRef}
            playsInline
            webkit-playsinline="true"
            onClick={() => { videoRef.current.muted = false; videoRef.current.play().catch(() => {}) }}
            className={currentChannelIndex === -1 ? 'static-video' : ''}
            style={{ visibility: isPoweredOn ? 'visible' : 'hidden', transform: `scale(${aspectRatio === 'auto' ? picture.crop : 1})` }}
          />
          {captionsOn && isPoweredOn && !showStatic && caption && <div className="closed-captions" aria-live="off">{caption.split('\n').map((line, i) => <div key={i}><span>{line}</span></div>)}</div>}
          </div>
          <StaticNoise active={showStatic && isPoweredOn} />
          {isPoweredOn && playbackStatus && <div className="playback-status" role="status">{playbackStatus}</div>}
          {isPoweredOn && autoplayBlocked && <button className="playback-resume" onClick={() => videoRef.current.play().catch(() => {})}>Click to play</button>}

          <div
            className={`channel-overlay ${showChannelOverlay ? 'show' : ''} ${channelEntryInvalid ? 'invalid' : ''}`}
          >
            CH {overlayChannelLabel}
          </div>

          <div className={`channel-name ${showChannelOverlay && overlayChannelName ? 'show' : ''}`}>
            {overlayChannelName}
          </div>

          <div className={`volume-overlay ${showVolumeOverlay ? 'show' : ''}`}>
            <span>VOL</span>
            <div className="volume-bar">
              <div
                className="volume-fill"
                style={{ width: `${Math.round(currentVolume * 100)}%` }}
              />
            </div>
          </div>

          {showGuide && (
            <div className="tv-guide">
              <div className="guide-header">
                <h2>TV GUIDE</h2>
                <div className="guide-settings">
                  <div className="guide-setting">
                    <span>ASPECT</span>
                    <div className="guide-toggle">
                      <button className={aspectRatio === 'auto' ? 'active' : ''} onClick={() => setAspectRatio('auto')}>AUTO</button>
                      <button
                        className={aspectRatio === '16:9' ? 'active' : ''}
                        onClick={() => setAspectRatio('16:9')}
                      >
                        16:9
                      </button>
                      <button
                        className={aspectRatio === '4:3' ? 'active' : ''}
                        onClick={() => setAspectRatio('4:3')}
                      >
                        4:3
                      </button>
                    </div>
                  </div>
                  <div className="guide-setting">
                    <span>CRT</span>
                    <div className="guide-toggle">
                      <button
                        className={!scanlines ? 'active' : ''}
                        onClick={() => setScanlines(false)}
                      >
                        OFF
                      </button>
                      <button
                        className={scanlines ? 'active' : ''}
                        onClick={() => setScanlines(true)}
                      >
                        ON
                      </button>
                    </div>
                  </div>
                </div>
                <div className="guide-time-now">
                  {currentTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </div>
                <button className="guide-close" aria-label="Close TV guide" onClick={() => setShowGuide(false)}>X</button>
              </div>
              <div className="guide-body">
                <div className="guide-channels" ref={channelsRef} onScroll={handleChannelsScroll}>
                  <div className="guide-channel-heading">CHANNEL</div>
                  {guideChannels.map(([slug, channelData]) => {
                    const channelNum = channels.findIndex(c => c.slug === slug) + 1
                    return (
                      <div
                        key={slug}
                        className={`guide-channel-name ${channels[currentChannelIndex]?.slug === slug ? 'current' : ''}`}
                        onClick={() => selectChannelFromGuide(slug)}
                      >
                        {channelNum}. {channelData.name}
                      </div>
                    )
                  })}
                </div>
                <div className="guide-schedule-container" ref={guideRef} onScroll={handleScheduleScroll}>
                  <div className="guide-schedule-scroll">
                    <div className="guide-time-axis">{guideTicks.map(tick => <span key={tick.time} style={{ left: tick.left }}>{formatTime(tick.time)}</span>)}</div>
                    {/* Current time indicator line */}
                    {guideData.dayStart && (
                      <div
                        className="guide-now-line"
                        style={{ left: (now - guideData.dayStart) / (60 * 1000) * (isMobile ? 5 : 10) }}
                      />
                    )}
                    {guideChannels.map(([slug, channelData]) => {
                      const pxPerMin = isMobile ? 5 : 10 // 50% scale on mobile
                      const combinedSchedule = channelData.schedule.filter(show => {
                        const left = (show.startTime - guideData.dayStart) / 60000 * pxPerMin
                        const right = (show.endTime - guideData.dayStart) / 60000 * pxPerMin
                        return right >= guideViewport.left - 600 && left <= guideViewport.left + guideViewport.width + 600
                      })
                      return (
                      <div key={slug} className="guide-channel-row" style={{ minWidth: (guideData.dayEnd - guideData.dayStart) / 60000 * pxPerMin }}>
                        {combinedSchedule.map((show, idx) => {
                          const isCurrent = show.startTime <= now && show.endTime > now
                          const showLeft = (show.startTime - guideData.dayStart) / 60000 * pxPerMin
                          const showWidth = show.duration / 60 * pxPerMin
                          const textInset = Math.max(0, guideViewport.left - showLeft)
                          const textWidth = Math.max(0, Math.min(showWidth - textInset - 24, guideViewport.width - 24))
                          return (
                          <div
                            key={`${show.hash}:${show.startTime}`}
                            role="button" tabIndex={0}
                            onClick={() => selectChannelFromGuide(slug)}
                            onKeyDown={event => { if (event.key === 'Enter') selectChannelFromGuide(slug) }}
                            title={`${show.title} · ${formatTime(show.startTime)}–${formatTime(show.endTime)}`}
                            className={`guide-show ${isCurrent ? 'current' : ''}`}
                            style={{
                              width: show.duration / 60 * pxPerMin,
                              left: (show.startTime - guideData.dayStart) / (60 * 1000) * pxPerMin
                            }}
                          >
                            <div className="guide-show-info" style={{ transform: `translateX(${textInset}px)`, width: textWidth }}>
                            <div className="guide-show-time">{formatTime(show.startTime)}</div>
                            <MarqueeTitle title={show.title} />
                            <div className="guide-show-duration">{formatDuration(show.duration)}{show.clipCount > 1 ? ` · ${show.clipCount} clips` : ''}</div>
                            </div>
                          </div>
                        )})}
                      </div>
                    )})}
                  </div>
                </div>
              </div>
            </div>
          )}

          {scanlines && isPoweredOn && <><div className="scanlines-overlay" /><div className="crt-glass" /></>}
        </div>
      </div>

      <div className="controls">
        <div className={`power-led ${isPoweredOn ? 'on' : ''}`}></div>
        <button
          className={`power-btn ${isPoweredOn ? 'on' : ''}`}
          onClick={togglePower}
          title="Power"
        >
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={channelDown} title="Channel Down" disabled={!isPoweredOn || channels.length === 0}>
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M7 10l5 5 5-5z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={channelUp} title="Channel Up" disabled={!isPoweredOn || channels.length === 0}>
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M7 14l5-5 5 5z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={volumeDown} title="Volume Down">
          <svg viewBox="0 0 28 24" width="28" height="24">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>
            <path d="M23 12h-6v-2h6v2z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={volumeUp} title="Volume Up">
          <svg viewBox="0 0 28 24" width="28" height="24">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>
            <path d="M23 11h-2V9h-2v2h-2v2h2v2h2v-2h2z" fill="currentColor"/>
          </svg>
        </button>
        <button className={`cc-button ${captionsOn ? 'active' : ''}`} onClick={() => setCaptionsOn(value => !value)} title={captionsOn && captionStatus ? `Closed captions: ${captionStatus}` : 'Closed captions'} aria-label="Closed captions" aria-pressed={captionsOn}>CC</button>
        <button onClick={toggleFullscreen} title="Fullscreen">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={toggleGuide} title="TV Guide">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" fill="currentColor"/>
            <rect x="2" y="4" width="3" height="16" rx="1" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

export default App
