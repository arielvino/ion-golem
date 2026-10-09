// Unit tests for weather/time journal records. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')

const state = require('../src/core/state')
const { Journal } = require('../src/world/journal')
const env = require('../src/perception/environment')

const at = (time, age, cycle = true) => ({ time, timeOfDay: time % 24000, age, cycle })

test('a clock that runs with the game ticks is no change', () => {
  assert.equal(env.timeChange(at(1000, 5000), at(1020, 5020)), null)
})

test('running into night or day is a phase change', () => {
  assert.deepEqual(env.timeChange(at(12990, 100), at(13010, 120)), { phase: 'night' })
  assert.deepEqual(env.timeChange(at(23990, 100), at(24010, 120)), { phase: 'day' })
})

test('a clock moved other than by elapsed ticks is a jump', () => {
  assert.deepEqual(env.timeChange(at(1000, 100), at(13000, 120)), { jump: 11980 })
  assert.deepEqual(env.timeChange(at(18000, 100), at(24000, 120)), { jump: 5980 })
})

test('a stopped clock never reads as a jump', () => {
  assert.equal(env.timeChange(at(6000, 100, false), at(6000, 2000, false)), null)
})

test('weather changes after login become records; the login state does not', async () => {
  state.journal = new Journal()
  const bot = new EventEmitter()
  bot.isRaining = true
  bot.thunderState = 0
  bot.time = {}
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    env.bind(bot)
    bot.isRaining = false; bot.emit('rain')         // still settling: login sync
    now += 5000
    bot.isRaining = true; bot.emit('rain')
    bot.thunderState = 0.3; bot.emit('weatherUpdate')
    bot.thunderState = 0.9; bot.emit('weatherUpdate')
    bot.thunderState = 0.4; bot.emit('weatherUpdate') // inside the hysteresis band
    bot.thunderState = 0; bot.emit('weatherUpdate')
  } finally { Date.now = realNow }
  assert.deepEqual(state.journal.records.map(r => r.text),
    ['weather: rain started', 'weather: thunderstorm started', 'weather: thunderstorm ended'])
})
