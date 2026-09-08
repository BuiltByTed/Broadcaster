const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const http = require('http')

const {
    OrchLogShipper,
    classifyLevel,
    readEnvironmentConfig,
    signBody,
    resetShipperForTests
} = require('../Utilities/OrchLogShipper.js')

const SECRET = 'test-secret-0123456789'

// Minimal stand-in for the orchestrator ingest endpoint. Verifies the signature the same way the
// receiver does: timing-safe compare over "<timestamp>.<raw body>" with a 10 minute clock window.
async function startMockReceiver(options = {}) {
    const received = []
    const statusQueue = Array.isArray(options.statuses) ? options.statuses.slice() : []

    const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8')
            const timestamp = req.headers['x-orch-timestamp']
            const signature = req.headers['x-orch-signature']
            const expected = signBody(SECRET, timestamp, rawBody)
            const signatureValid = Boolean(signature) &&
                signature.length === expected.length &&
                crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
            const timestampFresh = Number.isFinite(Number(timestamp)) &&
                Math.abs(Date.now() - Number(timestamp)) < 10 * 60 * 1000

            received.push({
                rawBody,
                timestamp,
                signature,
                signatureValid,
                timestampFresh,
                contentType: req.headers['content-type'],
                records: rawBody.split('\n').filter(Boolean).map(line => JSON.parse(line))
            })

            const status = statusQueue.length > 0 ? statusQueue.shift() : 202
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ accepted: signatureValid }))
        })
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()

    return {
        received,
        url: `http://127.0.0.1:${port}/api/projects/broadcaster/logs/ingest`,
        close: () => new Promise(resolve => server.close(resolve))
    }
}

test('smoke: one info line reaches the receiver with a valid signature and fresh timestamp', async () => {
    const receiver = await startMockReceiver()
    const correlationId = `smoke-${crypto.randomUUID()}`
    const shipper = new OrchLogShipper({ endpointUrl: receiver.url, secret: SECRET })

    try {
        assert.equal(shipper.enabled, true)
        shipper.enqueue({ level: 'info', msg: `broadcaster log ingest smoke ${correlationId}`, source: 'Main' })

        const result = await shipper.flush()

        assert.equal(result.sent, 1)
        assert.ok(result.status >= 200 && result.status < 300, `expected 2xx, got ${result.status}`)
        assert.equal(receiver.received.length, 1)

        const request = receiver.received[0]
        assert.equal(request.signatureValid, true, 'X-Orch-Signature must validate over "<timestamp>.<body>"')
        assert.equal(request.timestampFresh, true, 'X-Orch-Timestamp must be ms since epoch, within 10 minutes')
        assert.match(request.signature, /^sha256=[0-9a-f]{64}$/)
        assert.equal(request.contentType, 'application/x-ndjson')
        assert.equal(request.records.length, 1)

        const record = request.records[0]
        assert.equal(record.level, 'info')
        assert.equal(record.source, 'Main')
        assert.match(record.msg, new RegExp(correlationId))
        assert.equal(new Date(record.ts).toISOString(), record.ts, 'ts must be ISO-8601')
        assert.equal(record.queuedAt, undefined, 'internal bookkeeping must not be shipped')
    } finally {
        await receiver.close()
    }
})

test('body-only or stale signatures would be rejected: signed material includes the timestamp', () => {
    const body = '{"ts":"2026-01-01T00:00:00.000Z","level":"info","msg":"hi"}'
    const bodyOnly = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`
    assert.notEqual(signBody(SECRET, '1767225600000', body), bodyOnly)
    assert.notEqual(signBody(SECRET, '1767225600000', body), signBody(SECRET, '1767225600001', body))
})

test('Log() ships through the singleton with the tag as source and the channel name attached', async () => {
    const receiver = await startMockReceiver()
    const previousUrl = process.env.ORCH_LOG_INGEST_URL
    const previousSecret = process.env.ORCH_LOG_INGEST_SECRET
    const logPath = require.resolve('../Utilities/Log.js')
    const correlationId = `log-${crypto.randomUUID()}`

    process.env.ORCH_LOG_INGEST_URL = receiver.url
    process.env.ORCH_LOG_INGEST_SECRET = SECRET
    resetShipperForTests()
    delete require.cache[logPath]

    try {
        const Log = require(logPath)
        const { flushOrchLogs } = require('../Utilities/OrchLogShipper.js')

        await Log('PlaylistManager', `guide rebuilt ${correlationId}`, { name: 'Example Channel' })
        const result = await flushOrchLogs()

        assert.equal(result.sent, 1)
        const record = receiver.received[0].records[0]
        assert.equal(record.source, 'PlaylistManager')
        assert.equal(record.channel, 'Example Channel')
        assert.equal(record.level, 'info')
        assert.match(record.msg, new RegExp(correlationId))
    } finally {
        resetShipperForTests()
        delete require.cache[logPath]
        if (previousUrl === undefined) delete process.env.ORCH_LOG_INGEST_URL
        else process.env.ORCH_LOG_INGEST_URL = previousUrl
        if (previousSecret === undefined) delete process.env.ORCH_LOG_INGEST_SECRET
        else process.env.ORCH_LOG_INGEST_SECRET = previousSecret
        await receiver.close()
    }
})

test('Log() context ships the error, the stack, and a correlation id at error level', async () => {
    const receiver = await startMockReceiver()
    const previousUrl = process.env.ORCH_LOG_INGEST_URL
    const previousSecret = process.env.ORCH_LOG_INGEST_SECRET
    const logPath = require.resolve('../Utilities/Log.js')
    const correlationId = `req-${crypto.randomUUID()}`

    process.env.ORCH_LOG_INGEST_URL = receiver.url
    process.env.ORCH_LOG_INGEST_SECRET = SECRET
    resetShipperForTests()
    delete require.cache[logPath]

    try {
        const Log = require(logPath)
        const { flushOrchLogs } = require('../Utilities/OrchLogShipper.js')
        const { INSTANCE_ID } = require('../Utilities/LogContext.js')
        const failure = new Error('connect ECONNREFUSED')
        failure.code = 'ECONNREFUSED'

        // Deliberately neutral wording: the level must come from the attached error, not the text.
        await Log('LiveCheck', 'device check finished', { name: 'Example Channel' }, {
            error: failure,
            request_id: correlationId,
            device_id: 'live-3576-a1'
        })
        const result = await flushOrchLogs()

        assert.equal(result.sent, 1)
        const record = receiver.received[0].records[0]
        assert.equal(record.source, 'LiveCheck')
        assert.equal(record.channel, 'Example Channel')
        assert.equal(record.level, 'error', 'an attached error makes the record an error')
        assert.equal(record.error, 'Error: connect ECONNREFUSED')
        assert.equal(record.error_code, 'ECONNREFUSED')
        assert.match(record.error_stack, /at /, 'the call site must be recoverable from the record')
        assert.equal(record.correlation_id, correlationId)
        assert.equal(record.device_id, 'live-3576-a1')
        assert.equal(record.instance, INSTANCE_ID)
        assert.equal(record.queuedAt, undefined)
    } finally {
        resetShipperForTests()
        delete require.cache[logPath]
        if (previousUrl === undefined) delete process.env.ORCH_LOG_INGEST_URL
        else process.env.ORCH_LOG_INGEST_URL = previousUrl
        if (previousSecret === undefined) delete process.env.ORCH_LOG_INGEST_SECRET
        else process.env.ORCH_LOG_INGEST_SECRET = previousSecret
        await receiver.close()
    }
})

test('an Error in the channel slot is treated as context, not as a channel', async () => {
    const receiver = await startMockReceiver()
    const previousUrl = process.env.ORCH_LOG_INGEST_URL
    const previousSecret = process.env.ORCH_LOG_INGEST_SECRET
    const logPath = require.resolve('../Utilities/Log.js')

    process.env.ORCH_LOG_INGEST_URL = receiver.url
    process.env.ORCH_LOG_INGEST_SECRET = SECRET
    resetShipperForTests()
    delete require.cache[logPath]

    try {
        const Log = require(logPath)
        const { flushOrchLogs } = require('../Utilities/OrchLogShipper.js')

        await Log('Startup', 'shorthand', new Error('bare error'))
        await flushOrchLogs()

        const record = receiver.received[0].records[0]
        assert.equal(record.channel, undefined)
        assert.equal(record.error, 'Error: bare error')
        assert.match(record.error_stack, /at /)
    } finally {
        resetShipperForTests()
        delete require.cache[logPath]
        if (previousUrl === undefined) delete process.env.ORCH_LOG_INGEST_URL
        else process.env.ORCH_LOG_INGEST_URL = previousUrl
        if (previousSecret === undefined) delete process.env.ORCH_LOG_INGEST_SECRET
        else process.env.ORCH_LOG_INGEST_SECRET = previousSecret
        await receiver.close()
    }
})

test('context fields cannot overwrite the record envelope', async () => {
    const receiver = await startMockReceiver()
    const shipper = new OrchLogShipper({ endpointUrl: receiver.url, secret: SECRET, instanceId: 'test-instance' })

    try {
        shipper.enqueue({
            level: 'info',
            msg: 'real message',
            source: 'Envelope',
            fields: { ts: 'hijacked', level: 'fatal', msg: 'hijacked', instance: 'hijacked', kept: 'yes' }
        })
        await shipper.flush()

        const record = receiver.received[0].records[0]
        assert.equal(record.level, 'info')
        assert.equal(record.msg, 'real message')
        assert.equal(record.instance, 'test-instance')
        assert.equal(new Date(record.ts).toISOString(), record.ts)
        assert.equal(record.kept, 'yes')
    } finally {
        await receiver.close()
    }
})

test('classifyLevel escalates a neutral message that carries an error', () => {
    assert.equal(classifyLevel('device check finished'), 'info')
    assert.equal(classifyLevel('device check finished', { error: 'Error: boom' }), 'error')
    assert.equal(classifyLevel('device check finished', { error_stack: 'Error: boom\n    at x' }), 'error')
    assert.equal(classifyLevel('retrying in 5s', {}), 'warn')
})

test('explicit enqueue level wins over failed/error message wording', () => {
    const shipper = new OrchLogShipper({
        endpointUrl: 'http://127.0.0.1:9/ingest',
        secret: SECRET,
        setTimeoutImpl: () => null
    })
    shipper.enqueue({
        level: 'warn',
        msg: 'Skipping unreadable media corrupt.mkv (exit code 183)',
        source: 'PreGenerator',
        fields: { exit_code: 183 }
    })
    assert.equal(shipper.queue[0].level, 'warn')
    // Without explicit level the same wording would still be warn via "Skipping";
    // "Failed to generate" would be error — confirm the override path works for that case too.
    shipper.enqueue({
        level: 'warn',
        msg: 'Failed to generate corrupt.mkv (exit code 183)',
        source: 'PreGenerator'
    })
    assert.equal(shipper.queue[1].level, 'warn')
})

test('batches at 100 records per request', async () => {
    const receiver = await startMockReceiver()
    const shipper = new OrchLogShipper({ endpointUrl: receiver.url, secret: SECRET })

    try {
        for (let i = 0; i < 250; i += 1) {
            shipper.enqueue({ level: 'info', msg: `line ${i}`, source: 'Bulk' })
        }
        await shipper.flush()
        await shipper.close()

        const counts = receiver.received.map(request => request.records.length)
        assert.equal(counts.reduce((total, count) => total + count, 0), 250)
        assert.ok(counts.every(count => count <= 100), `batch too large: ${counts.join(',')}`)
        assert.equal(counts[0], 100)
    } finally {
        await receiver.close()
    }
})

test('non-2xx reports once to stderr, backs off 30s, then retries the same records', async () => {
    const receiver = await startMockReceiver({ statuses: [500] })
    const stderr = []
    let clock = Date.now()
    const shipper = new OrchLogShipper({
        endpointUrl: receiver.url,
        secret: SECRET,
        now: () => clock,
        setTimeoutImpl: () => null,
        writeStderr: line => stderr.push(line)
    })

    try {
        shipper.enqueue({ level: 'error', msg: 'segment write failed', source: 'PreGenerator' })
        const failed = await shipper.flush()

        assert.equal(failed.sent, 0)
        assert.equal(stderr.length, 1)
        assert.match(stderr[0], /\[orch-log-shipper\].*status 500/)
        assert.equal(shipper.queue.length, 1, 'failed batch stays queued for retry')

        const duringBackoff = await shipper.flush()
        assert.equal(duringBackoff.skipped, 'backoff')
        assert.equal(receiver.received.length, 1, 'no retry inside the backoff window')

        clock += 30 * 1000
        const retried = await shipper.flush()
        assert.equal(retried.sent, 1)
        assert.equal(receiver.received.length, 2)
        assert.equal(receiver.received[1].records[0].level, 'error')
        assert.equal(stderr.length, 1, 'failures must not recurse into the transport')
    } finally {
        await receiver.close()
    }
})

test('drops records older than 5 minutes instead of holding them forever', async () => {
    const receiver = await startMockReceiver()
    let clock = Date.now()
    const shipper = new OrchLogShipper({
        endpointUrl: receiver.url,
        secret: SECRET,
        now: () => clock,
        setTimeoutImpl: () => null
    })

    try {
        shipper.enqueue({ level: 'info', msg: 'stale line', source: 'Main' })
        clock += 5 * 60 * 1000 + 1
        shipper.enqueue({ level: 'info', msg: 'fresh line', source: 'Main' })

        const result = await shipper.flush()

        assert.equal(result.sent, 1)
        assert.equal(receiver.received.length, 1)
        assert.deepEqual(receiver.received[0].records.map(record => record.msg), ['fresh line'])
        assert.equal(shipper.droppedRecords, 1)
    } finally {
        await receiver.close()
    }
})

test('queue is bounded so a dead endpoint cannot grow memory without limit', async () => {
    const shipper = new OrchLogShipper({
        endpointUrl: 'http://127.0.0.1:1/ingest',
        secret: SECRET,
        maxQueuedRecords: 10,
        setTimeoutImpl: () => null,
        writeStderr: () => {}
    })

    for (let i = 0; i < 40; i += 1) {
        shipper.enqueue({ level: 'info', msg: `line ${i}`, source: 'Main' })
    }

    assert.equal(shipper.queue.length, 10)
    assert.equal(shipper.queue[0].msg, 'line 30')
})

test('disabled without both env vars, and accepts either variable spelling', () => {
    assert.deepEqual(readEnvironmentConfig({}), { endpointUrl: null, secret: null })

    const canonical = readEnvironmentConfig({
        ORCH_LOG_INGEST_URL: 'https://example.test/ingest',
        ORCH_LOG_INGEST_SECRET: 'abc'
    })
    assert.deepEqual(canonical, { endpointUrl: 'https://example.test/ingest', secret: 'abc' })

    const alias = readEnvironmentConfig({
        ORCH_LOG_INGESTION_URL: 'https://example.test/ingest',
        ORCH_LOG_INGESTION_SECRET: 'abc'
    })
    assert.deepEqual(alias, canonical)

    const urlOnly = new OrchLogShipper({ endpointUrl: 'https://example.test/ingest' })
    assert.equal(urlOnly.enabled, false)
    assert.equal(urlOnly.enqueue({ msg: 'ignored' }), false)
})

test('level is inferred from message text when the caller has none', () => {
    assert.equal(classifyLevel('Error loading channels.json: ENOENT'), 'error')
    assert.equal(classifyLevel('Unable to start the TV UI'), 'error')
    assert.equal(classifyLevel('Retrying ffprobe'), 'warn')
    assert.equal(classifyLevel('Web UI started and ready'), 'info')
    assert.equal(classifyLevel(undefined), 'info')
    // Unreadable library media: warn, not ERROR (avoids log-monitor tickets for bad files)
    assert.equal(
        classifyLevel('Skipping unreadable media show.mkv — probe found no usable streams'),
        'warn'
    )
    assert.equal(
        classifyLevel('Skipping unreadable media show.mkv (encode exit 183)'),
        'warn'
    )
    assert.equal(
        classifyLevel('Skipping video after encode exit: /media/show.mkv'),
        'warn'
    )
    // Legacy wording that used to fire tickets for the same corrupt file
    assert.equal(classifyLevel('Failed to generate show.mkv (exit code 183)'), 'error')
    assert.equal(classifyLevel('Error: core of 1, misdetection possible!'), 'error')
    assert.equal(classifyLevel('Skipping failed video: /media/show.mkv'), 'error')
})

// PreGenerator unreadable-media wording (#3597): must stay WARN so log-monitor
// does not re-file tickets for corrupt library files.
test('unreadable-media skip messages classify as warn, not error', () => {
    assert.equal(classifyLevel('Skipping failed video: /media/bad.mkv'), 'error')
    assert.equal(classifyLevel('Skipping unreadable media: bad.mkv'), 'warn')
    assert.equal(classifyLevel('Skipping unreadable video: /media/bad.mkv'), 'warn')
    assert.equal(classifyLevel('Skipping encode for unreadable source: bad.mkv (exit 183)'), 'warn')
    assert.equal(classifyLevel('Skipping video after unexpected issue: /media/bad.mkv'), 'warn')
    assert.equal(classifyLevel('Processing bad.mkv [error ?x? ? ?bit | audio: ?]'), 'error')
    assert.equal(classifyLevel('Processing bad.mkv [unreadable ?x? ? ?bit | audio: ?]'), 'info')
    assert.equal(classifyLevel('Failed to generate bad.mkv (exit code 183)'), 'error')
    assert.equal(classifyLevel('Error: EBML header parsing failed'), 'error')
    // stderr tails go in context fields now — never as a second message body
})

// Opt-in: hits the real orchestrator endpoint when the container/CI environment supplies both vars.
const liveConfig = readEnvironmentConfig()
test('live ingest endpoint accepts a signed batch', { skip: liveConfig.endpointUrl && liveConfig.secret ? false : 'ORCH log ingest env not set' }, async () => {
    const shipper = new OrchLogShipper(liveConfig)
    shipper.enqueue({
        level: 'info',
        msg: `broadcaster live ingest smoke ${crypto.randomUUID()}`,
        source: 'OrchLogShipperTest'
    })
    const result = await shipper.flush()
    assert.equal(result.sent, 1)
    assert.ok(result.status >= 200 && result.status < 300, `expected 2xx, got ${result.status}`)
})


test('retry timer remains armed during backoff without new log records', async () => {
    let now = 1000
    let timer
    let calls = 0
    const shipper = new OrchLogShipper({
        endpointUrl: 'https://logs.example.test', secret: SECRET,
        now: () => now,
        setTimeoutImpl: callback => { timer = callback; return { unref() {} } },
        clearTimeoutImpl: () => {}, writeStderr: () => {},
        fetchImpl: async () => ({ status: ++calls === 1 ? 503 : 202 })
    })
    shipper.enqueue({ msg: 'one record' })
    timer()
    await shipper.pending
    assert.equal(calls, 1)
    now += 1000
    timer()
    await shipper.pending
    assert.ok(shipper.timer, 'backoff must schedule another retry')
    now += 30000
    timer()
    await shipper.pending
    assert.equal(calls, 2)
    assert.equal(shipper.queue.length, 0)
    await shipper.close()
})
