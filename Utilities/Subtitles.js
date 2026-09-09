const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const Sqlite = require('better-sqlite3')

const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'sami'])
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024
const jobs = new Map()
let running = 0

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 90000, maxBuffer: MAX_SUBTITLE_BYTES, encoding: 'utf8', env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' } },
      (error, stdout) => error ? reject(new Error('Subtitle conversion failed')) : resolve(stdout))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function subtitleRank(track) {
  const language = String(track.languageCode || track.tags?.language || 'und').toLowerCase()
  if (!['en', 'eng', 'english', 'und', ''].includes(language)) return -1
  return (['en', 'eng', 'english'].includes(language) ? 10 : 0) - (track.forced || track.disposition?.forced ? 20 : 0) + (track.default || track.disposition?.default ? 1 : 0)
}

function mapPlexPath(filePath, mappings) {
  for (const mapping of [...(mappings || [])].sort((a, b) => b.to.length - a.to.length)) {
    if (filePath.startsWith(mapping.to + '/')) return mapping.from + filePath.slice(mapping.to.length)
  }
  return null
}

async function boundedText(response) {
  if (!response.ok) throw new Error('Subtitle source unavailable')
  if (Number(response.headers.get('content-length')) > MAX_SUBTITLE_BYTES) { await response.body?.cancel(); throw new Error('Subtitle response too large') }
  const reader = response.body.getReader(), chunks = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_SUBTITLE_BYTES) { await reader.cancel(); throw new Error('Subtitle response too large') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function plexSubtitle(filePath) {
  let servers
  try { servers = JSON.parse(await fs.readFile(process.env.PLEX_SERVERS_FILE || path.join(process.env.CACHE_DIR, 'plex-servers.json'), 'utf8')) } catch { return null }
  for (const server of servers) {
    const plexPath = mapPlexPath(filePath, server.pathMappings)
    if (!plexPath) continue
    try {
      // Read-only exact file match: two cuts or similarly named episodes cannot
      // accidentally borrow each other's subtitles. Never modify Plex's DB.
      let db, id
      try {
        db = new Sqlite(server.databasePath, { readonly: true, fileMustExist: true, timeout: 2000 })
        id = db.prepare('SELECT m.metadata_item_id AS id FROM media_parts p JOIN media_items m ON m.id=p.media_item_id WHERE p.file=? AND p.deleted_at IS NULL AND m.deleted_at IS NULL LIMIT 1').get(plexPath)?.id
      } finally { db?.close() }
      if (!Number.isSafeInteger(id)) continue
      const preferences = server.token ? '' : await fs.readFile(server.preferencesPath, 'utf8')
      const token = server.token || preferences.match(/PlexOnlineToken="([^"]+)"/)?.[1]
      if (!token) continue
      const headers = { 'X-Plex-Token': token, Accept: 'application/json' }
      const metadata = JSON.parse(await boundedText(await fetch(new URL(`/library/metadata/${id}`, server.url), { headers, signal: AbortSignal.timeout(10000), redirect: 'error' })))
      const parts = (metadata.MediaContainer?.Metadata || []).flatMap(item => item.Media || []).flatMap(item => item.Part || [])
      const streams = parts.filter(part => part.file === plexPath).flatMap(part => part.Stream || [])
        .filter(stream => stream.streamType === 3 && TEXT_CODECS.has(stream.codec) && /^\/library\/streams\/\d+$/.test(stream.key || '') && subtitleRank(stream) >= 0)
        .sort((a, b) => subtitleRank(b) - subtitleRank(a))
      for (const stream of streams) {
        try {
          const text = await boundedText(await fetch(new URL(stream.key, server.url), { headers, signal: AbortSignal.timeout(15000), redirect: 'error' }))
          return await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', stream.codec === 'srt' || stream.codec === 'subrip' ? 'srt' : stream.codec, '-i', 'pipe:0', '-f', 'webvtt', 'pipe:1'], text)
        } catch { /* Try another track, then the local media. */ }
      }
    } catch { /* Plex downtime must not affect playback or local subtitles. */ }
  }
  return null
}

async function localSubtitle(filePath) {
  const directory = path.dirname(filePath), stem = path.basename(filePath, path.extname(filePath))
  const names = await fs.readdir(directory)
  const candidates = names.filter(name => {
    if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) return false
    const base = name.slice(0, -path.extname(name).length)
    if (base === stem) return true
    if (!base.startsWith(stem + '.')) return false
    const tags = base.slice(stem.length + 1).toLowerCase().split(/[. _-]+/)
    return tags.every(tag => ['en', 'eng', 'english', 'sdh', 'cc', 'default'].includes(tag))
  }).sort((a, b) => Number(b.includes('.en')) - Number(a.includes('.en')))
  for (const name of candidates) {
    try {
      const full = path.join(directory, name)
      if ((await fs.stat(full)).size > MAX_SUBTITLE_BYTES) continue
      return await run('ffmpeg', ['-v', 'error', '-nostdin', '-i', full, '-f', 'webvtt', 'pipe:1'])
    } catch { /* Another sidecar or embedded track may still work. */ }
  }
  return null
}

async function extract(filePath) {
  const external = await localSubtitle(filePath) || await plexSubtitle(filePath)
  if (external) return external
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 's', '-show_streams', '-of', 'json', filePath]))
  const tracks = (probe.streams || []).filter(track => TEXT_CODECS.has(track.codec_name) && subtitleRank(track) >= 0)
    .sort((a, b) => subtitleRank(b) - subtitleRank(a))
  for (const track of tracks) {
    try { return await run('ffmpeg', ['-v', 'error', '-nostdin', '-i', filePath, '-map', `0:${track.index}`, '-f', 'webvtt', 'pipe:1']) } catch {}
  }
  return null
}

async function keyFor(filePath) {
  const stat = await fs.stat(filePath)
  return crypto.createHash('sha256').update(`${filePath}:${stat.size}:${stat.mtimeMs}`).digest('hex')
}

function directory() { return path.join(process.env.CACHE_DIR, 'subtitles') }

async function prepare(filePath, key) {
  const text = await extract(filePath)
  const result = { status: text && text.includes(' --> ') ? 'ready' : 'unavailable', checkedAt: Date.now() }
  await fs.mkdir(directory(), { recursive: true })
  if (result.status === 'ready') {
    await fs.writeFile(path.join(directory(), `${key}.vtt.tmp`), text)
    await fs.rename(path.join(directory(), `${key}.vtt.tmp`), path.join(directory(), `${key}.vtt`))
  }
  await fs.writeFile(path.join(directory(), `${key}.json.tmp`), JSON.stringify(result))
  await fs.rename(path.join(directory(), `${key}.json.tmp`), path.join(directory(), `${key}.json`))
  return result
}

function drain() {
  for (const [key, job] of jobs) {
    if (running >= 2) break
    if (job.started) continue
    job.started = true; running++
    prepare(job.filePath, key).catch(() => { job.failedAt = Date.now() }).finally(() => {
      running--
      if (job.failedAt) { job.started = true; setTimeout(() => jobs.delete(key), 30000).unref() } else jobs.delete(key)
      drain()
    })
  }
}

async function getSubtitles(filePath) {
  const key = await keyFor(filePath)
  try {
    const result = JSON.parse(await fs.readFile(path.join(directory(), `${key}.json`), 'utf8'))
    if (Date.now() - result.checkedAt < (result.status === 'ready' ? 86400000 : 600000)) {
      if (result.status === 'ready') await fs.access(path.join(directory(), `${key}.vtt`))
      return { ...result, key }
    }
  } catch {}
  if (!jobs.has(key) && jobs.size < 40) { jobs.set(key, { filePath }); drain() }
  return { status: jobs.get(key)?.failedAt ? 'unavailable' : 'preparing', key }
}

module.exports = { getSubtitles, keyFor, directory, subtitleRank, mapPlexPath, extract }
