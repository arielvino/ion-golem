// Unit tests for the vertical strategies' goal (src/navigation/goals.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const state = require('../src/core/state')
const { reachGoal, levelGoal } = require('../src/navigation/goals')

function at(y) { state.bot = { entity: { position: new Vec3(0.5, y, 0.5) } } }

test('reach: 3 blocks below the target counts as arrived (why pillar needs its own goal)', () => {
  at(47)
  assert.strictEqual(reachGoal(0, 50, 0, 2).isDone(), true)
})

test('pillar: done only at the target Y or above', () => {
  const g = levelGoal(0, 48, 0, { atLeast: true })
  at(47); assert.strictEqual(g.isDone(), false)
  at(48); assert.strictEqual(g.isDone(), true)
  at(49); assert.strictEqual(g.isDone(), true)
})

test('staircase: done only at the target Y', () => {
  const g = levelGoal(5, 40, 0)
  at(42); assert.strictEqual(g.isDone(), false)
  at(41); assert.strictEqual(g.isDone(), false)
  at(40); assert.strictEqual(g.isDone(), true)
  at(39); assert.strictEqual(g.isDone(), false)
})
