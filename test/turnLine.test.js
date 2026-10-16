// The bot's own [TURN] line (engine.turnLine): one form for every turn, saying only
// why the turn happens. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const state = require('../src/core/state')
const holdMode = require('../src/engine/holdMode')
const { turnLine } = require('../src/engine/engine')
const { queueSummary } = require('../src/engine/backgroundTask')

function scene({ food = 20, stack = [{ t: 'protect Sargon' }], queue = [] } = {}) {
  state.bot = {
    food, health: 20, oxygenLevel: 20, isInWater: false,
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 }, entities: {},
    nearestEntity: () => null, blockAt: () => null
  }
  state.taskStack = stack
  state.actionQueue = queue
  state.backgroundTask = null
  state.noActionRounds = 0
  state.ctxRequests = []
  holdMode.release('test')
}

test('a goal with nothing running: a turn to work on it', () => {
  scene()
  assert.deepStrictEqual(turnLine(null), { line: '[TURN] woke=goal', working: true })
})

test('actions running or queued: a turn that is not counted as idle work', () => {
  scene({ queue: [{ actionStr: 'mine:stone:3' }, { actionStr: 'craft:stone_pickaxe' }] })
  assert.deepStrictEqual(turnLine(null), { line: '[TURN] woke=task-running', working: false })
  // Bro, 2026-10-14 20:05: queue=1 was read as running. The context names them, in order.
  assert.strictEqual(queueSummary(), 'mine:stone:3→craft:stone_pickaxe')
})

test('a finished task and the goal both show in woke=', () => {
  scene()
  assert.strictEqual(turnLine({ actionStr: 'mine:log:4', status: 'done' }).line, '[TURN] woke=task-finished,goal')
})

test('no progress for 3 turns is said once, then counted again', () => {
  scene()
  state.noActionRounds = 3
  assert.strictEqual(turnLine(null).line, '[TURN] woke=goal no_progress=3')
  assert.strictEqual(turnLine(null).line, '[TURN] woke=goal')
})

test('held: no turn for the goal, nor for a task that just ended', () => {
  scene()
  holdMode.hold('Sargon')
  assert.strictEqual(turnLine(null), null)
  assert.strictEqual(turnLine({ actionStr: 'follow:Sargon', status: 'aborted' }), null)
  holdMode.release('test')
})

test('held: a real signal still wakes it', () => {
  scene({ food: 0 })
  holdMode.hold('Sargon')
  assert.deepStrictEqual(turnLine(null), { line: '[TURN] woke=starving', working: false })
  holdMode.release('test')
})

test('released: the goal is worked on again', () => {
  scene()
  holdMode.hold('Sargon')
  holdMode.release('resume')
  assert.strictEqual(turnLine(null).line, '[TURN] woke=goal')
})

test('idle with nothing to do: a look around now and then, not every tick', () => {
  scene({ stack: [] })
  const first = turnLine(null)
  assert.strictEqual(first?.line ?? null, first ? '[TURN] woke=idle-check' : null)
  assert.strictEqual(turnLine(null), null)
})
