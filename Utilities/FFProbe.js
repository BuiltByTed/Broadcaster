const { execFileSync } = require('child_process')

module.exports = {
    getDurationInMilliseconds(filePath) {
        const duration = Number(execFileSync('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filePath
        ], { encoding: 'utf8', timeout: 15000 }))
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid media duration')
        return duration * 1000
    }
}
