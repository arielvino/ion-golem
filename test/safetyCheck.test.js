// When the engine asks for a [SAFETY] turn, and the time/regen fields it adds to the context.
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const safety = require('../src/engine/safetyCheck')

const fakeBot = ({ t = 1000, day = 3, hp = 20, food = 20, dim = 'minecraft:overworld', difficulty = 'normal' } = {}) => ({
  entity: {}, health: hp, food, time: { timeOfDay: t, day }, game: { dimension: dim, difficulty },
})
const fresh = (opts) => { safety.onDeath(); state.bot = fakeBot(opts); return state.bot }

test('a full, fed bot at noon is not asked', () => {
  fresh({ t: 6000 })
  assert.strictEqual(safety.safetyReason(), null)
})

test('dusk asks once a day, four real minutes ahead', () => {
  fresh({ t: 13000 - 4801 })
  assert.strictEqual(safety.safetyReason(), null)
  state.bot.time.timeOfDay = 13000 - 4800
  assert.strictEqual(safety.safetyReason(), 'night in 4m00s')
  state.bot.time.timeOfDay = 12000
  assert.strictEqual(safety.safetyReason(), null)          // already asked today
  state.bot.time.day = 4; state.bot.time.timeOfDay = 9000
  assert.strictEqual(safety.safetyReason(), 'night in 3m20s')
})

test('woken at night it says so, and a death asks again', () => {
  fresh({ t: 18000 })
  assert.match(safety.safetyReason(), /^it is night: .* day in 4m10s$/)
  assert.strictEqual(safety.safetyReason(), null)
  safety.onDeath()
  assert.match(safety.safetyReason(), /^it is night/)
})

test('HP down and not healing asks once, until HP is back above 10', () => {
  fresh({ t: 1000, hp: 9, food: 15 })
  assert.strictEqual(safety.safetyReason(), 'HP 9/20 and not healing: food 15/20 is under 18')
  assert.strictEqual(safety.safetyReason(), null)
  state.bot.health = 14
  assert.strictEqual(safety.safetyReason(), null)
  state.bot.health = 8
  assert.match(safety.safetyReason(), /^HP 8\/20 and not healing/)
})

test('HP down but healing (food 18+) is not asked', () => {
  fresh({ t: 1000, hp: 6, food: 19 })
  assert.strictEqual(safety.safetyReason(), null)
})

test('no day cycle in the nether, nothing on peaceful', () => {
  fresh({ t: 18000, dim: 'minecraft:the_nether' })
  assert.strictEqual(safety.safetyReason(), null)
  fresh({ t: 18000, hp: 4, food: 2, difficulty: 'peaceful' })
  assert.strictEqual(safety.safetyReason(), null)
})

test('context fields: night_in by day, day_in at night, regen=off when food is under 18', () => {
  assert.strictEqual(safety.timeLine(fakeBot({ t: 9735 })), ' night_in=2m43s')
  assert.strictEqual(safety.timeLine(fakeBot({ t: 23500 })), ' night_in=11m15s')
  assert.strictEqual(safety.timeLine(fakeBot({ t: 18000 })), ' night_now day_in=4m10s')
  assert.strictEqual(safety.timeLine(fakeBot({ dim: 'the_end' })), '')
  assert.strictEqual(safety.regenLine(fakeBot({ hp: 9, food: 15 })), ' regen=off(food<18)')
  assert.strictEqual(safety.regenLine(fakeBot({ hp: 20, food: 15 })), '')
  assert.strictEqual(safety.regenLine(fakeBot({ hp: 9, food: 18 })), '')
})
