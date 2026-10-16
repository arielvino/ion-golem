// night_in= / day_in= after time=, regen=off after food=.
const test = require('node:test')
const assert = require('node:assert')
const { timeLine, regenLine } = require('../src/ai/survivalFields')

const bot = ({ t = 1000, hp = 20, food = 20, dim = 'minecraft:overworld' } = {}) =>
  ({ health: hp, food, time: { timeOfDay: t }, game: { dimension: dim } })

test('night_in by day (real time), day_in at night, nothing without a day cycle', () => {
  assert.strictEqual(timeLine(bot({ t: 9735 })), ' night_in=2m43s')
  assert.strictEqual(timeLine(bot({ t: 23500 })), ' night_in=11m15s')
  assert.strictEqual(timeLine(bot({ t: 12990 })), ' night_in=1s')
  assert.strictEqual(timeLine(bot({ t: 18000 })), ' night_now day_in=4m10s')
  assert.strictEqual(timeLine(bot({ dim: 'the_end' })), '')
})

test('regen=off only when HP is down and food is under 18', () => {
  assert.strictEqual(regenLine(bot({ hp: 9, food: 15 })), ' regen=off(food<18)')
  assert.strictEqual(regenLine(bot({ hp: 20, food: 15 })), '')
  assert.strictEqual(regenLine(bot({ hp: 9, food: 18 })), '')
})
