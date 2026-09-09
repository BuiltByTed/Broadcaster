const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const { chromium } = require('@playwright/test')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-playback-'))
Object.assign(process.env, { CACHE_DIR: scratch, WEB_UI_PORT: '12129', VIDEO_CODEC: 'libx264',
  VIDEO_PRESET: 'ultrafast', VIDEO_FILTER: '', DIMENSIONS: '320x180', HLS_SEGMENT_LENGTH_SECONDS: '1',
  SUPPORTED_FORMATS: 'mp4,mkv', LOG_LEVEL: 'silent' })
const { Channel } = require('../Classes/Channel.js')
const Database = require('../Utilities/Database.js')
const encoder = require('../Utilities/PreGenerator.js')
const pool = require('../Utilities/ChannelPool.js')()
const ui = require('../Webapp/TelevisionUI.js')()
const { getPrevious3am, getNext3am } = require('../Utilities/GuideGenerator.js')

async function main() {
  let browser
  try {
    const root = path.join(scratch, 'Music Videos')
    fs.mkdirSync(root)
    const captionFile = path.join(root, 'clip0.en.srt')
    fs.writeFileSync(captionFile, '1\n00:00:00,000 --> 00:00:08,000\nCLASSIC TV CAPTIONS\nSecond line\n')
    for (let i = 0; i < 2; i++) {
      // The second clip has no source audio, exercising generated silent AAC.
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${i ? 'blue' : 'red'}:s=320x180:r=25`,
        ...(i ? ['-i', captionFile] : ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']),
        '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text', path.join(root, `clip${i}.mp4`)])
    }
    // Check real external and embedded subtitle conversion without transcoding video.
    const { extract } = require('../Utilities/Subtitles.js')
    for (let i = 0; i < 2; i++) assert.match(await extract(path.join(root, `clip${i}.mp4`)), /CLASSIC TV CAPTIONS/)
    // Reproduce a damaged source clock: 8 seconds of video stretched to 100.
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25:d=8',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=8',
      '-vf', 'setpts=12.5*PTS', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', path.join(root, 'clip2.mkv')])
    for (const slug of ['mtv', 'tv2']) {
      const channel = new Channel({ slug, name: slug === 'mtv' ? 'MTV' : 'Second Channel', type: 'alphabetical', paths: [root] })
      pool.addChannel(channel)
      for (const row of Database().getChannelVideos(slug)) await encoder.generateVideo(row.id, row.file_path, channel)
      const videos = Database().getChannelVideos(slug, true)
      assert.equal(videos.length, 3)
      for (const video of videos) assert.ok(Math.abs(video.duration_seconds - 8) < 0.2, `Unexpected repaired duration: ${video.duration_seconds}`)
      const now = Date.now()
      let time = now - 16000
      const schedule = Array.from({ length: 100 }, (_, i) => {
        const video = videos[i % videos.length]
        const startTime = time
        time += video.duration_seconds * 1000
        return { hash: video.hash, filePath: video.file_path, title: 'Music Videos', startTime, endTime: time,
          duration: video.duration_seconds, segmentCount: video.segment_count, cacheVersion: 2 }
      })
      channel.guideGenerator.saveGuide({ version: 3, channelSlug: slug, dayStart: getPrevious3am(), dayEnd: getNext3am(),
        schedule, shuffleState: { videoCount: 3, remaining: [] } })
      channel.start()
      // Old caches can have 25+ second segments, requiring a much longer
      // forward window. Playback must still match wall clock, not its edge.
      channel.playlistManager.targetDuration = 30
    }
    pool.setStartupStatus('ready')
    ui.start(pool)
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    let partialResponses = 0
    let firstProgramTime = null
    const errors = []
    page.on('response', response => { if (response.url().endsWith('/stream.ts') && response.status() === 206) partialResponses++ })
    page.on('response', async response => {
      if (new URL(response.url()).pathname !== '/mtv.m3u8' || firstProgramTime !== null) return
      const playlist = await response.text().catch(() => '')
      const match = playlist.match(/#EXT-X-PROGRAM-DATE-TIME:([^\n]+)/)
      if (match && firstProgramTime === null) firstProgramTime = Date.parse(match[1])
    })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://127.0.0.1:12129')
    await page.getByTitle('Power', { exact: true }).click()
    const started = Date.now()
    await page.getByTitle('Channel Up', { exact: true }).click()
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !document.querySelector('.playback-status') && !v.paused && v.readyState >= 3 && v.currentTime > 0 })
    const tuneMs = Date.now() - started
    const firstTime = await page.locator('video').evaluate(video => video.currentTime)
    await page.waitForTimeout(19000)
    const later = await page.locator('video').evaluate(video => ({ time: video.currentTime, ready: video.readyState, paused: video.paused }))
    assert.ok(later.time - firstTime > 17, JSON.stringify(later))
    assert.equal(later.paused, false)
    assert.ok(Number.isFinite(firstProgramTime), 'Expected broadcast timestamp')
    const clockErrorSeconds = (firstProgramTime + later.time * 1000 - Date.now()) / 1000
    assert.ok(Math.abs(clockErrorSeconds) < 3, `Picture is ${clockErrorSeconds}s away from the guide clock`)
    await page.getByRole('button', { name: 'Closed captions', exact: true }).click()
    await page.waitForSelector('.closed-captions', { timeout: 20000 })
    assert.match(await page.locator('.closed-captions').innerText(), /CLASSIC TV CAPTIONS/)
    await page.screenshot({ path: '/tmp/broadcaster-captions.png' })
    await page.getByTitle('TV Guide', { exact: true }).click()
    await page.waitForSelector('.guide-show')
    const cells = await page.locator('.guide-show').count()
    assert.ok(cells < 20, `Guide should render visible blocks only, got ${cells}`)
    await page.getByRole('button', { name: 'ON', exact: true }).click()
    await page.screenshot({ path: '/tmp/broadcaster-guide-desktop.png' })
    await page.getByLabel('Close TV guide').click()
    for (let i = 0; i < 8; i++) await page.getByTitle('Channel Up', { exact: true }).click({ delay: 5 })
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !document.querySelector('.playback-status') && !v.paused && v.readyState >= 3 })
    // Adjacent-channel warmup removes the manifest + fragment network round trips.
    await page.waitForTimeout(5000)
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 5000000, uploadThroughput: 5000000 })
    const warmStarted = Date.now()
    await page.getByTitle('Channel Down', { exact: true }).click()
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !v.paused && v.readyState >= 3 && document.querySelector('.static-noise').hidden })
    const warmTuneMs = Date.now() - warmStarted
    assert.ok(warmTuneMs < 1200, `Warmed tune with 400ms network latency took ${warmTuneMs}ms`)
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await session.detach()
    // Force a connection failure and verify that the same channel resumes.
    await page.context().setOffline(true)
    await page.waitForTimeout(3000)
    await page.context().setOffline(false)
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !document.querySelector('.playback-status') && !v.paused && v.readyState >= 3 })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTitle('TV Guide', { exact: true }).click()
    await page.waitForSelector('.guide-show')
    await page.screenshot({ path: '/tmp/broadcaster-guide-mobile.png' })
    await page.getByLabel('Close TV guide').click()
    await page.getByTitle('Power', { exact: true }).click()
    await page.waitForTimeout(700)
    assert.equal(await page.locator('video').evaluate(video => video.paused), true)
    assert.deepEqual(errors, [])
    assert.ok(partialResponses > 10, `Expected HTTP byte-range playback, got ${partialResponses} partial responses`)
    console.log(JSON.stringify({ tuneMs, warmTuneMs, clockErrorSeconds, continuousPlaybackSeconds: later.time - firstTime, visibleGuideCells: cells, partialResponses, browserErrors: errors }))
  } finally {
    await browser?.close()
    ui.stop()
    encoder.stopActiveWorkers()
    Database().close()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
