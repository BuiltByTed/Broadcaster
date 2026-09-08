const crypto = require('crypto')
const { INSTANCE_ID, RESERVED_FIELDS } = require('./LogContext.js')

// Batching / delivery limits. Receiver caps a batch at 1000 records and 2 MB.
const MAX_BATCH_RECORDS = 100
const FLUSH_INTERVAL_MS = 1000
const MAX_QUEUED_RECORDS = 1000
const MAX_RECORD_AGE_MS = 5 * 60 * 1000
const RETRY_BACKOFF_MS = 30 * 1000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 10 * 1000

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

const ERROR_PATTERN = /\b(error|errors|failed|failing|failure|unable|exception|crash|crashed|fatal|denied|refused)\b/i
const WARN_PATTERN = /\b(warn|warning|warnings|retry|retrying|skipping|skipped|deprecated|timeout|timed out)\b/i

// Log lines carry no level of their own, so infer one from the message text. A line that carries an
// error object in its context is about a failure regardless of how the message is worded.
function classifyLevel(message, fields) {
    const text = typeof message === 'string' ? message : String(message ?? '')
    if (ERROR_PATTERN.test(text)) return 'error'
    if (fields && (fields.error !== undefined || fields.error_stack !== undefined)) return 'error'
    if (WARN_PATTERN.test(text)) return 'warn'
    return 'info'
}

function firstValue(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return null
}

// Both spellings are accepted so the container can be configured either way.
function readEnvironmentConfig(env = process.env) {
    return {
        endpointUrl: firstValue(env.ORCH_LOG_INGEST_URL, env.ORCH_LOG_INGESTION_URL),
        secret: firstValue(env.ORCH_LOG_INGEST_SECRET, env.ORCH_LOG_INGESTION_SECRET)
    }
}

function signBody(secret, timestamp, body) {
    const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    return `sha256=${digest}`
}

class OrchLogShipper {
    constructor(options = {}) {
        this.endpointUrl = options.endpointUrl || null
        this.secret = options.secret || null
        this.fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args))
        this.now = options.now || (() => Date.now())
        this.setTimeoutImpl = options.setTimeoutImpl || setTimeout
        this.clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout
        this.writeStderr = options.writeStderr || (line => process.stderr.write(line))
        this.maxBatchRecords = options.maxBatchRecords || MAX_BATCH_RECORDS
        this.flushIntervalMs = options.flushIntervalMs || FLUSH_INTERVAL_MS
        this.maxQueuedRecords = options.maxQueuedRecords || MAX_QUEUED_RECORDS
        this.maxRecordAgeMs = options.maxRecordAgeMs || MAX_RECORD_AGE_MS
        this.retryBackoffMs = options.retryBackoffMs || RETRY_BACKOFF_MS
        this.instanceId = options.instanceId || INSTANCE_ID

        this.queue = []
        this.timer = null
        this.pending = null
        this.flushRequested = false
        this.retryAfter = 0
        this.droppedRecords = 0
        this.closed = false
    }

    get enabled() {
        return Boolean(this.endpointUrl && this.secret)
    }

    // Never throws: logging must not be able to take down a caller.
    enqueue(record) {
        if (!this.enabled || this.closed) return false
        try {
            const fields = record.fields && typeof record.fields === 'object' ? record.fields : null
            const level = LEVELS.includes(record.level) ? record.level : classifyLevel(record.msg, fields)
            const entry = {
                ts: record.ts || new Date(this.now()).toISOString(),
                level,
                msg: typeof record.msg === 'string' ? record.msg : String(record.msg ?? ''),
                instance: this.instanceId,
                queuedAt: this.now()
            }
            if (record.source) entry.source = String(record.source)
            if (record.channel) entry.channel = String(record.channel)
            // Context fields never overwrite the record envelope.
            if (fields) {
                for (const [key, value] of Object.entries(fields)) {
                    if (value === undefined || RESERVED_FIELDS.has(key)) continue
                    entry[key] = value
                }
            }

            this.queue.push(entry)
            while (this.queue.length > this.maxQueuedRecords) {
                this.queue.shift()
                this.droppedRecords += 1
            }

            if (this.queue.length >= this.maxBatchRecords) {
                this.requestFlush()
            } else {
                this.scheduleFlush()
            }
            return true
        } catch (e) {
            this.reportFailure(`enqueue failed: ${e && e.message ? e.message : e}`)
            return false
        }
    }

    // Collapses the burst case: one pending flush no matter how many records arrive at once.
    requestFlush() {
        if (this.flushRequested) return
        this.flushRequested = true
        this.flush().catch(() => {})
    }

    scheduleFlush() {
        if (this.timer || this.closed || this.queue.length === 0) return
        this.timer = this.setTimeoutImpl(() => {
            this.timer = null
            this.flush().catch(() => {})
        }, this.flushIntervalMs)
        if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
    }

    dropExpired() {
        const cutoff = this.now() - this.maxRecordAgeMs
        const kept = this.queue.filter(entry => entry.queuedAt >= cutoff)
        this.droppedRecords += this.queue.length - kept.length
        this.queue = kept
    }

    // Pull the next batch, honouring both the record count and the body-size cap.
    takeBatch() {
        const batch = []
        let bytes = 0
        while (this.queue.length > 0 && batch.length < this.maxBatchRecords) {
            const line = serializeRecord(this.queue[0])
            const size = Buffer.byteLength(line, 'utf8') + 1
            if (batch.length > 0 && bytes + size > MAX_BODY_BYTES) break
            batch.push(this.queue.shift())
            bytes += size
        }
        return batch
    }

    // Flushes serialize: a caller awaiting flush() waits for any in-flight delivery first, so the
    // shutdown path cannot exit while a batch is still on the wire.
    flush(options = {}) {
        if (!this.enabled) return Promise.resolve({ sent: 0 })
        const drain = () => this.drain(options)
        this.pending = (this.pending || Promise.resolve()).then(drain, drain)
        return this.pending
    }

    async drain(options = {}) {
        this.flushRequested = false
        if (!options.ignoreBackoff && this.now() < this.retryAfter) {
            this.scheduleFlush()
            return { sent: 0, skipped: 'backoff' }
        }

        let sent = 0
        let lastStatus = null
        try {
            while (true) {
                this.dropExpired()
                const batch = this.takeBatch()
                if (batch.length === 0) break

                const result = await this.deliver(batch)
                lastStatus = result.status
                if (!result.ok) {
                    // Requeue at the head so ordering survives the retry.
                    this.queue = batch.concat(this.queue)
                    while (this.queue.length > this.maxQueuedRecords) {
                        this.queue.pop()
                        this.droppedRecords++
                    }
                    this.retryAfter = this.now() + this.retryBackoffMs
                    break
                }
                sent += batch.length
                this.retryAfter = 0
            }
        } finally {
            if (this.queue.length > 0) this.scheduleFlush()
        }
        return { sent, status: lastStatus }
    }

    async deliver(batch) {
        const body = batch.map(serializeRecord).join('\n')
        const timestamp = String(this.now())
        try {
            const response = await this.fetchImpl(this.endpointUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-ndjson',
                    'x-orch-timestamp': timestamp,
                    'x-orch-signature': signBody(this.secret, timestamp, body)
                },
                body,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            })
            if (response?.body?.cancel) await response.body.cancel()
            if (!response || response.status < 200 || response.status >= 300) {
                const status = response ? response.status : 'no-response'
                this.reportFailure(`ingest rejected ${batch.length} record(s) with status ${status}`)
                return { ok: false, status: response ? response.status : null }
            }
            return { ok: true, status: response.status }
        } catch (e) {
            this.reportFailure(`ingest POST failed: ${e && e.message ? e.message : e}`)
            return { ok: false, status: null }
        }
    }

    // Straight to stderr on purpose: routing this through Log() would feed the transport its own
    // failures and loop forever.
    reportFailure(message) {
        try {
            this.writeStderr(`[orch-log-shipper] ${message}\n`)
        } catch (e) {
            // stderr is gone; nothing useful left to do.
        }
    }

    async close() {
        if (this.timer) {
            this.clearTimeoutImpl(this.timer)
            this.timer = null
        }
        const result = await this.flush({ ignoreBackoff: true })
        this.closed = true
        return result
    }
}

function serializeRecord(entry) {
    const { queuedAt, ...record } = entry
    return JSON.stringify(record)
}

let singleton = null
let exitHooksRegistered = false

function getShipper() {
    if (!singleton) {
        singleton = new OrchLogShipper(readEnvironmentConfig())
        if (singleton.enabled && !exitHooksRegistered) {
            exitHooksRegistered = true
            process.once('beforeExit', () => {
                flushOrchLogs()
            })
        }
    }
    return singleton
}

// `context` is either the normalized shape from LogContext.normalizeContext() ({ fields }) or a plain
// object of fields; both are accepted so callers outside Log() can ship structured detail too.
// Optional `level` wins over message/heuristic classification when it is a known level name.
function shipLogRecord(tag, message, channel, context, level) {
    try {
        const shipper = getShipper()
        if (!shipper.enabled) return false
        const fields = context && typeof context === 'object'
            ? (context.fields && typeof context.fields === 'object' ? context.fields : context)
            : null
        return shipper.enqueue({
            msg: message,
            source: tag,
            channel: channel && channel.name ? channel.name : undefined,
            fields,
            level: typeof level === 'string' ? level : undefined
        })
    } catch (e) {
        return false
    }
}

// Flush whatever is buffered; used by the shutdown path so a graceful stop keeps its tail.
async function flushOrchLogs() {
    try {
        const shipper = getShipper()
        if (!shipper.enabled) return { sent: 0 }
        return await shipper.close()
    } catch (e) {
        return { sent: 0 }
    }
}

function resetShipperForTests() {
    singleton = null
}

module.exports = {
    OrchLogShipper,
    classifyLevel,
    readEnvironmentConfig,
    signBody,
    shipLogRecord,
    flushOrchLogs,
    getShipper,
    resetShipperForTests,
    MAX_BATCH_RECORDS,
    FLUSH_INTERVAL_MS,
    MAX_RECORD_AGE_MS,
    RETRY_BACKOFF_MS,
    MAX_BODY_BYTES
}
