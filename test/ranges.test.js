// Unit tests for the ranges resolver. Run: node --test
const test = require('node:test')
const assert = require('node:assert')

const state = require('../state')
const ranges = require('../config/ranges')

test('chunkLoad sentinel resolves to serverViewDistance*16 at runtime', () => {
  state.bot = { game: { serverViewDistance: 10 } }
  assert.equal(ranges.sight.playerVisibility, 160)
  assert.equal(ranges.sight.lookBlocks, 160)
  assert.equal(ranges.sight.nearbyEntities, 160)
  assert.equal(ranges.chunkLoadBlocks(), 160)

  state.bot = { game: { serverViewDistance: 16 } }
  assert.equal(ranges.sight.playerVisibility, 256)
})

test('falls back to 10 chunks when serverViewDistance is missing', () => {
  state.bot = null
  assert.equal(ranges.chunkLoadBlocks(), 160)
  state.bot = { game: {} }
  assert.equal(ranges.sight.lookEntities, 160)
})

test('numeric values pass through unchanged', () => {
  state.bot = { game: { serverViewDistance: 10 } }
  assert.equal(ranges.sight.ambientSurveyBlocks, 64)
  assert.equal(ranges.sight.ambientFovDegrees, 120)
  assert.equal(ranges.sight.lookReportCap, 15)
  assert.equal(ranges.hearing.soundSubtitles, 48)
})
