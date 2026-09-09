// Keep only the broadcast position and a few seconds ahead of the two adjacent
// channels. The cache owns its buffers; hls.js can transfer a copy to its worker.
export function parseWarmPlaylist(text, url) {
  const segments = []
  let time = 0, duration = 0, range = null, previousEnd = 0, previousUrl = ''
  const offset = Number(text.match(/#EXT-X-START:TIME-OFFSET=([-\d.]+)/)?.[1])
  for (const line of text.split(/\r?\n/).map(line => line.trim())) {
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0])
    else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17).split('@').map(Number)
    else if (line && !line.startsWith('#') && duration > 0) {
      const absolute = new URL(line, url).href
      const start = range ? (range[1] ?? (absolute === previousUrl ? previousEnd : NaN)) : undefined
      const end = range ? start + range[0] : undefined
      if (new URL(absolute).origin !== new URL(url).origin || (range && (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start))) return null
      segments.push({ url: absolute, rangeStart: start, rangeEnd: end, time, duration })
      time += duration
      previousEnd = end
      previousUrl = absolute
      duration = 0
      range = null
    }
  }
  if (!segments.length || !Number.isFinite(offset)) return null
  return { segments, offset: offset < 0 ? time + offset : offset, duration: time }
}

// hls.js uses 0/0 for a full-file request, whereas parsed URIs have no range.
const keyFor = context => `${context.url}|${context.rangeEnd > context.rangeStart ? `${context.rangeStart}:${context.rangeEnd}` : ''}`
const MAX_BYTES = 32 * 1024 * 1024
const MAX_FRAGMENT = 8 * 1024 * 1024

export class ChannelWarmup {
  constructor() { this.media = new Map(); this.manifests = new Map(); this.bytes = 0 }
  has(context) { const item = this.media.get(keyFor(context)); return Boolean(item && Date.now() - item.at < 20000) }
  get(context) {
    const item = this.media.get(keyFor(context))
    if (item && Date.now() - item.at < 20000) return item.data.slice(0)
    return null
  }
  takeManifest(url) {
    const item = this.manifests.get(url)
    this.manifests.delete(url)
    if (!item || Date.now() - item.at > 2500) return null
    const age = (Date.now() - item.at) / 1000
    const parsed = parseWarmPlaylist(item.text, url)
    if (!parsed || parsed.offset + age >= parsed.duration) return null
    return item.text.replace(/(#EXT-X-START:TIME-OFFSET=)[-\d.]+/, `$1${(parsed.offset + age).toFixed(3)}`)
  }
  put(context, data) {
    if (data.byteLength > MAX_FRAGMENT) return
    const key = keyFor(context)
    if (this.media.has(key)) this.bytes -= this.media.get(key).data.byteLength
    this.media.delete(key)
    this.media.set(key, { data, at: Date.now() })
    this.bytes += data.byteLength
    for (const [oldKey, item] of this.media) {
      if (this.bytes <= MAX_BYTES && this.media.size <= 32 && Date.now() - item.at < 20000) break
      this.media.delete(oldKey)
      this.bytes -= item.data.byteLength
    }
  }
  async warm(url, signal) {
    const began = Date.now()
    const response = await fetch(url, { cache: 'no-store', signal, priority: 'low' })
    if (!response.ok) return
    const text = await response.text()
    const parsed = parseWarmPlaylist(text, url)
    if (!parsed || signal.aborted) return
    for (const [key, item] of this.manifests) if (Date.now() - item.at > 2500) this.manifests.delete(key)
    this.manifests.set(url, { text, at: began })
    const position = parsed.offset + (Date.now() - began) / 1000
    const needed = parsed.segments.filter(s => s.time + s.duration > position - 0.2 && s.time < position + 4).slice(0, 7)
    for (const segment of needed) {
      if (signal.aborted) return
      if (this.has(segment)) continue
      const ranged = segment.rangeEnd !== undefined
      if (ranged && segment.rangeEnd - segment.rangeStart > MAX_FRAGMENT) continue
      const res = await fetch(segment.url, { signal, priority: 'low', headers: ranged ? { Range: `bytes=${segment.rangeStart}-${segment.rangeEnd - 1}` } : {} })
      // Never accidentally download a multi-hour stream when a proxy ignores Range.
      if (!res.ok || (ranged && res.status !== 206) || Number(res.headers.get('content-length')) > MAX_FRAGMENT) { await res.body?.cancel(); continue }
      const reader = res.body.getReader()
      const chunks = []
      let length = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_FRAGMENT) { await reader.cancel(); break }
        chunks.push(value)
      }
      if (length > MAX_FRAGMENT || signal.aborted || (ranged && length !== segment.rangeEnd - segment.rangeStart)) continue
      const data = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
      this.put(segment, data.buffer)
    }
  }
  follow(urls) {
    this.stop()
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal
    const tick = async () => {
      if (!document.hidden && !navigator.connection?.saveData) {
        await Promise.allSettled([...new Set(urls)].map(url => this.warm(new URL(url, location.href).href, signal)))
      }
      if (!signal.aborted) this.timer = setTimeout(tick, 1500)
    }
    // Let the selected channel get its first frame before speculative traffic.
    this.timer = setTimeout(tick, 500)
    return () => { if (this.controller === controller) this.stop() }
  }
  stop() { this.controller?.abort(); this.controller = null; clearTimeout(this.timer) }
  clear() { this.stop(); this.manifests.clear(); this.media.clear(); this.bytes = 0 }
}

export function warmLoader(BaseLoader, cache) {
  return class extends BaseLoader {
    load(context, config, callbacks) {
      const data = context.responseType === 'arraybuffer' ? cache.get(context) : cache.takeManifest(context.url)
      if (data === null) return super.load(context, config, callbacks)
      this.context = context
      this.warmCallbacks = callbacks
      const now = performance.now()
      Object.assign(this.stats.loading, { start: now, first: now, end: now + 0.1 })
      this.stats.loaded = this.stats.total = typeof data === 'string' ? data.length : data.byteLength
      queueMicrotask(() => {
        if (!this.cancelled) callbacks.onSuccess({ url: context.url, data }, this.stats, context, null)
      })
    }
    abort() { this.cancelled = true; if (this.warmCallbacks) this.warmCallbacks.onAbort?.(this.stats, this.context, null); else super.abort() }
    destroy() { this.cancelled = true; this.warmCallbacks = null; super.destroy() }
  }
}
