const express = require('express')
const fs = require('fs')
const path = require('path')

/**
 * HLS under /channels may only expose media segments/playlists.
 * Blocks path manifests, metadata, DB files, and other non-media paths.
 * Mounted at /channels so req.path is relative to that prefix.
 */
function allowHlsStaticPath(req, res, next) {
    const requestPath = req.path || ''
    const base = path.basename(requestPath)

    if (
        base === 'manifest.json' ||
        base === 'metadata.json' ||
        base.endsWith('.db') ||
        base.endsWith('.db-wal') ||
        base.endsWith('.db-shm')
    ) {
        return res.status(404).end()
    }

    if (!/\.(m3u8|ts)$/i.test(requestPath)) {
        return res.status(404).end()
    }

    return next()
}

function setHlsStaticHeaders(res, filePath) {
    if (filePath.endsWith('.ts')) {
        res.set('Content-Type', 'video/mp2t')
        res.set('Cache-Control', 'public, max-age=3600')
    }
}

/**
 * Serve only public UI assets + filtered channel HLS.
 * Never mounts CACHE_DIR root (DB, history, manifests stay off the static tree).
 *
 * @param {import('express').Application} app
 * @param {string} cacheDir
 * @param {string} webappDir absolute path to Webapp/ (for dist/static copies)
 */
function mountPublicStatic(app, cacheDir, webappDir) {
    const publicDir = path.join(cacheDir, 'public')
    const channelsDir = path.join(cacheDir, 'channels')

    fs.mkdirSync(publicDir, { recursive: true })
    fs.mkdirSync(channelsDir, { recursive: true })

    // Serve shipped assets directly: no stale copies or large startup file copies.
    app.use(express.static(path.join(webappDir, 'dist'), {
        setHeaders(res, filePath) {
            res.set('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable')
        }
    }))
    for (const slug of ['static', 'static-4x3']) {
        app.use(`/channels/${slug}`, allowHlsStaticPath, express.static(path.join(webappDir, slug), {
            setHeaders: setHlsStaticHeaders
        }))
    }

    app.use('/channels', allowHlsStaticPath, express.static(channelsDir, {
        setHeaders: setHlsStaticHeaders
    }))
}

module.exports = {
    allowHlsStaticPath,
    mountPublicStatic,
    setHlsStaticHeaders
}
