// Unit tests for the hold (src/engine/holdMode.js) as the engine sees it. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const state = require('../src/core/state')
const holdMode = require('../src/engine/holdMode')
const { autonomousLine } = require('../src/engine/engine')

function scene({ food = 20 } = {}) {
  state.bot = {
    food, health: 20, oxygenLevel: 20, isInWater: false,
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 }, entities: {},
    nearestEntity: () => null, blockAt: () => null
  }
  state.taskStack = [{ t: 'protect Sargon' }]
  state.actionQueue = []
  state.backgroundTask = null
  state.noActionRounds = 0
}

test('a goal on the agenda gets a SELF-CHECK every tick', () => {
  scene()
  holdMode.release('test')
  assert.strictEqual(autonomousLine(null).kind, 'task')
})

test('held: no SELF-CHECK for the goal, nor for a task that just ended', () => {
  scene()
  holdMode.hold('Sargon')
  assert.strictEqual(autonomousLine(null), null)
  assert.strictEqual(autonomousLine({ actionStr: 'follow:Sargon', status: 'aborted' }), null)
  holdMode.release('test')
})

test('held: a real signal still wakes it', () => {
  scene({ food: 0 })
  holdMode.hold('Sargon')
  assert.deepStrictEqual(autonomousLine(null), { kind: 'held', line: '[SELF-CHECK] held' })
  holdMode.release('test')
})

test('released: the goal is worked on again', () => {
  scene()
  holdMode.hold('Sargon')
  holdMode.release('resume')
  assert.strictEqual(holdMode.isHeld(), false)
  assert.strictEqual(autonomousLine(null).kind, 'task')
})
