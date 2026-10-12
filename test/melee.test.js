// Melee (src/combat/melee.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Melee, cooldownTicks } = require('../src/combat/melee')

function fakeBot() {
  const bot = new EventEmitter()
  bot.calls = []
  bot.pathfinder = {
    goal: null,
    setGoal(g) { this.goal = g; bot.calls.push(['setGoal', g && g.constructor.name]) },
    setMovements() { bot.calls.push(['setMovements']) },
    stop() { bot.calls.push(['stop']); setImmediate(() => bot.emit('path_stop')) },
    isMoving: () => false
  }
  bot.entity = { position: { distanceTo: () => 10 }, onGround: true }
  return bot
}
const zombie = { name: 'zombie', position: { distanceTo: () => 10 } }

test('a sword swings every 12 ticks at full damage, an unknown item every 5', () => {
  assert.strictEqual(cooldownTicks('iron_sword'), 12)
  assert.strictEqual(cooldownTicks(''), 5)
})

test('the chase uses the bot\'s own pathfinder movements', async () => {
  const bot = fakeBot()
  const melee = new Melee(bot)
  await melee.attack(zombie)
  assert.strictEqual(melee.target, zombie)
  assert.deepStrictEqual(bot.calls, [['setGoal', 'GoalFollow']])
})

test('stop names the target that stopped', async () => {
  const bot = fakeBot()
  const melee = new Melee(bot)
  await melee.attack(zombie)
  let stopped
  bot.on('stoppedAttacking', t => { stopped = t })
  await melee.stop()
  assert.strictEqual(stopped, zombie)
  assert.strictEqual(melee.target, undefined)
})
