const test = require('node:test')
const assert = require('node:assert/strict')

const Format = require('../Utilities/FormatValidator.js')

test.before(() => {
  process.env.SUPPORTED_FORMATS = 'mov,mp4,mkv,avi,ts,m2ts,webm,divx,mpg'
})

test('accepts lowercase extension', () => {
  assert.equal(Format.isSupported('Movie.mp4'), true)
  assert.equal(Format.isSupported('/media/Show.mkv'), true)
})

test('accepts uppercase extension', () => {
  assert.equal(Format.isSupported('Movie.MP4'), true)
  assert.equal(Format.isSupported('Show.MKV'), true)
})

test('accepts mixed-case extension', () => {
  assert.equal(Format.isSupported('clip.Mp4'), true)
  assert.equal(Format.isSupported('clip.MkV'), true)
})

test('rejects unsupported extension', () => {
  assert.equal(Format.isSupported('doc.pdf'), false)
  assert.equal(Format.isSupported('archive.ZIP'), false)
})

test('matches formats case-insensitively when config is mixed case', () => {
  const prev = process.env.SUPPORTED_FORMATS
  process.env.SUPPORTED_FORMATS = 'MP4, Mkv'
  try {
    assert.equal(Format.isSupported('a.mp4'), true)
    assert.equal(Format.isSupported('a.MKV'), true)
    assert.equal(Format.isSupported('a.avi'), false)
  } finally {
    process.env.SUPPORTED_FORMATS = prev
  }
})

test('rejects extensionless files, dotfiles, and works when SUPPORTED_FORMATS is unset', () => {
  const prev = process.env.SUPPORTED_FORMATS
  try {
    assert.equal(Format.isSupported('mp4'), false)
    assert.equal(Format.isSupported('.mp4'), false)
    assert.equal(Format.isSupported('/media/show.mp4/README'), false)
    delete process.env.SUPPORTED_FORMATS
    assert.equal(Format.isSupported('/media/movie.mp4'), true)
    assert.equal(Format.isSupported('/media/notes.txt'), false)
  } finally {
    process.env.SUPPORTED_FORMATS = prev
  }
})
