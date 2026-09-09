const profiles = new Map()

// Geometry comes from a source profile, shared with the encoder. Revisiting a
// program no longer depends on whether its first frame happens to be dark.
export function watchPicture(video, onPicture) {
  let program = null, profile = null, controller = null, retry = null
  const inspect = () => {
    if (!video.videoHeight) return
    const ratio = video.videoWidth / video.videoHeight
    const legacyCrop = program && program.cacheVersion < 3 && profile?.crop && ratio > 1.55
    onPicture({ aspect: legacyCrop || ratio < 1.55 ? '4:3' : '16:9', crop: legacyCrop ? ratio / (4 / 3) : 1 })
  }
  const reset = () => { controller?.abort(); clearTimeout(retry); program = null; profile = null }
  const setProgram = next => {
    if (program?.hash === next.hash && program?.cacheVersion === next.cacheVersion) return
    reset()
    program = next
    profile = profiles.get(next.hash)
    inspect()
    // v3 streams already contain the crop. Older streams use the SAME stable
    // source profile as a temporary display crop until their rebuild is adopted.
    if (next.cacheVersion >= 3 || profile) return
    controller = new AbortController()
    const { signal } = controller
    const load = async () => {
      try {
        const response = await fetch(`/api/picture/${encodeURIComponent(next.slug)}/${next.hash}`, { signal })
        if (!response.ok) throw new Error('Picture profile not ready')
        const value = await response.json()
        if (signal.aborted) return
        profiles.set(next.hash, value)
        if (profiles.size > 128) profiles.delete(profiles.keys().next().value)
        profile = value
        inspect()
      } catch { if (!signal.aborted) retry = setTimeout(load, 5000) }
    }
    load()
  }
  video.addEventListener('emptied', reset)
  video.addEventListener('resize', inspect)
  video.addEventListener('playing', inspect)
  const stop = () => { reset(); video.removeEventListener('emptied', reset); video.removeEventListener('resize', inspect); video.removeEventListener('playing', inspect) }
  stop.setProgram = setProgram
  return stop
}
