const path = require('path')
const Log = require('./Log.js')
const tag = 'FormValidator'
const DEFAULT_SUPPORTED_FORMATS = 'mov,mp4,mkv,avi,ts,m2ts,webm,divx,mpg'

// Checks the given file against the SUPPORTED_FORMATS list
module.exports = {
    isSupported: file => {
      var valid = false
      try {
        const ext = path.extname(String(file)).slice(1).toLowerCase()
        if (!ext) return false
        ;(process.env.SUPPORTED_FORMATS || DEFAULT_SUPPORTED_FORMATS).split(',')
          .forEach(format => {
          if (ext == format.trim().toLowerCase()) {
            valid = true
          }
        })
      } catch(e) {
        Log(tag, `Unable to validate file format for ${file}: ${e.message}`, undefined, { error: e, file })
      }
      return valid
    }
}
