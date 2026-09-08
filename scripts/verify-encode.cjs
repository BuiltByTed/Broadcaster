// Run against a scratch CACHE_DIR with production media mounted read-only.
require('dotenv').config({ path: process.env.CONFIG_FILE || './config.docker.txt' })
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const Database = require('../Utilities/Database.js')
const encoder = require('../Utilities/PreGenerator.js')
const { parseHlsPlaylist } = require('../Utilities/HlsPlaylist.js')

async function main() {
  const db = Database()
  const channel = { slug: 'encode-check', name: 'Encode check' }
  const id = db.upsertChannel(channel.slug, channel.name, 'alphabetical')
  for (const file of process.argv.slice(2)) {
    const hash = crypto.createHash('md5').update(file).digest('hex')
    db.insertVideo(id, file, hash, path.basename(file))
    const row = db.getVideoByHash(channel.slug, hash)
    const started = Date.now()
    await encoder.generateVideo(row.id, file, channel)
    const updated = db.getVideoByHash(channel.slug, hash)
    assert.equal(updated.cache_version, 2)
    const directory = path.join(process.env.CACHE_DIR, 'channels', channel.slug, 'videos', hash, 'v2')
    const playlistPath = path.join(directory, 'index.m3u8')
    const playlist = parseHlsPlaylist(fs.readFileSync(playlistPath, 'utf8'))
    assert.ok(playlist.complete)
    assert.ok(playlist.maxDuration <= 1.25, `Long segment: ${playlist.maxDuration}`)
    for (const segment of [playlist.segments[0], playlist.segments.at(-1)]) {
      assert.ok(fs.statSync(path.join(directory, segment.uri)).size > 0)
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-read_intervals', '%+#1', '-show_frames', '-of', 'json', path.join(directory, segment.uri)], { encoding: 'utf8' }))
      assert.equal(probe.frames[0]?.key_frame, 1)
    }
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', playlistPath, '-t', '5', '-f', 'null', '-'], { timeout: 30000 })
    console.log(JSON.stringify({ file: path.basename(file), segments: playlist.segments.length,
      maxSegmentSeconds: playlist.maxDuration, duration: playlist.duration,
      encodingSeconds: (Date.now() - started) / 1000, cacheVersion: updated.cache_version }))
  }
  db.close()
}
main().catch(error => { console.error(error); process.exitCode = 1 })
