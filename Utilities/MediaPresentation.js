const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { streamDuration } = require('./MediaTiming.js')

const processes = new Set(), pending = new Map()
let active = 0, stopping = false
const waiters = []

function run(command, args) {
  return new Promise((resolve, reject) => {
    if (stopping) return reject(new Error('Presentation analysis stopping'))
    const child = execFile(command, args, { timeout: 20000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => error ? reject(new Error('Presentation analysis unavailable')) : resolve({ stdout, stderr }))
    processes.add(child)
    child.once('close', () => processes.delete(child))
  })
}

function explicitFraming(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  if (/\/[^/]*(?:tvdb-71470|star[ ._-]+trek[^/]*next[ ._-]+generation)[^/]*\//.test(normalized)) return '4:3'
  if (/\/[^/]*(?:tvdb-77811|frasier[ ._-]*\(1993\))[^/]*\//.test(normalized)) {
    const season = Number(normalized.match(/\/season[ ._-]*(\d+)/)?.[1] || normalized.match(/[ ._-]s(\d{1,2})e\d/)?.[1])
    if (season >= 1 && season <= 8) return '4:3'
    if (season >= 9 && season <= 11) return '16:9'
  }
  return null
}

function ratioOf(video) {
  const sar = String(video.sample_aspect_ratio || '1:1').split(':').map(Number)
  const pixelRatio = sar[0] > 0 && sar[1] > 0 ? sar[0] / sar[1] : 1
  return { ratio: video.width * pixelRatio / video.height, pixelRatio }
}

function cropFor(video) {
  const { ratio, pixelRatio } = ratioOf(video)
  if (!(ratio > 1.55 && ratio < 1.95)) return null
  const width = Math.floor(video.height * (4 / 3) / pixelRatio / 2) * 2
  return { width, height: video.height, x: Math.floor((video.width - width) / 4) * 2, y: 0, sourceWidth: video.width }
}

function cropConsensus(samples, ratio) {
  const expectedWidth = 320 * (4 / 3) / ratio
  let confirmed = 0
  for (const sample of samples) {
    const matches = [...sample.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map(match => ({ width: +match[1], x: +match[3] }))
    if (!matches.length) continue
    // The widest observed image is the safe crop at this position. Ignore top
    // and bottom bars: cinematic letterboxing is intentionally retained.
    const widest = matches.reduce((a, b) => a.width > b.width ? a : b)
    if (widest.width > 310) return false
    if (Math.abs(widest.width - expectedWidth) <= 6 && Math.abs(widest.x - (320 - widest.width) / 2) <= 3) confirmed++
  }
  return confirmed >= 3
}

async function analyze(filePath, supplied) {
  let video = supplied
  if (!video?.width || !video?.height || !video?.duration) {
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath])).stdout)
    video = (probe.streams || []).find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
    if (!video) throw new Error('No video for presentation analysis')
    video = { ...video, duration: streamDuration(video) || Number(probe.format?.duration) }
  }
  const { ratio } = ratioOf(video)
  const rule = explicitFraming(filePath)
  let crop = null
  if (rule === '4:3') crop = cropFor(video)
  else if (!rule && ratio > 1.55 && ratio < 1.95 && video.duration > 2) {
    const samples = []
    for (const fraction of [0.15, 0.35, 0.65, 0.85]) {
      const result = await run('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '2', '-filter_threads', '1',
        '-ss', String(Math.max(0, video.duration * fraction - 0.5)), '-i', filePath,
        '-map', `0:${video.index ?? video.streamIndex ?? 0}`, '-an', '-sn', '-dn', '-frames:v', '6',
        '-vf', 'scale=320:180,cropdetect=24:2:1', '-f', 'null', '-'])
      samples.push(result.stderr)
    }
    if (cropConsensus(samples, ratio)) crop = cropFor(video)
  }
  return { version: 1, aspect: crop || ratio < 1.55 ? '4:3' : '16:9', crop, rule, sourceRatio: ratio }
}

async function getPresentation(filePath, supplied) {
  const stat = await fs.stat(filePath)
  const key = crypto.createHash('sha256').update(`${filePath}:${stat.size}:${stat.mtimeMs}:1`).digest('hex')
  const directory = path.join(process.env.CACHE_DIR, 'presentation')
  const output = path.join(directory, `${key}.json`)
  try { return JSON.parse(await fs.readFile(output, 'utf8')) } catch {}
  if (pending.has(key)) return pending.get(key)
  if (pending.size >= 40) throw new Error('Presentation analysis busy')
  const promise = (async () => {
    if (active >= 2) await new Promise(resolve => waiters.push(resolve))
    else active++
    try {
      const result = await analyze(filePath, supplied)
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(output + '.tmp', JSON.stringify(result))
      await fs.rename(output + '.tmp', output)
      return result
    } finally { const next = waiters.shift(); if (next) next(); else active-- }
  })()
  pending.set(key, promise)
  try { return await promise } finally { pending.delete(key) }
}

function stop() { stopping = true; for (const child of processes) child.kill('SIGKILL') }
module.exports = { getPresentation, explicitFraming, cropFor, cropConsensus, stop }
