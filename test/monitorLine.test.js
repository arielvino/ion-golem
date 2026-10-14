// Unit tests for the [MONITOR] line (engine.autonomousLine). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { autonomousLine } = require('../src/engine/engine')

// Bro, 2026-10-14 20:05: the line said queue=1, and the model logged both
// "digdown and mine:stone:3 already running" while mine:stone:3 only waited.
test('MONITOR names the queued actions, in order', () => {
  state.taskStack = [{ t: 'stone_pickaxe and cobblestone' }]
  state.backgroundTask = null
  state.actionQueue = [{ actionStr: 'mine:stone:3' }, { actionStr: 'craft:stone_pickaxe' }]
  const out = autonomousLine(null)
  assert.strictEqual(out.kind, 'monitor')
  assert.match(out.line, / queue=mine:stone:3→craft:stone_pickaxe$/)
})
