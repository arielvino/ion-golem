// When the engine asks for a [PLAN-FIRST] turn: the focus reached a goal with no route.
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { parse, apply } = require('../src/engine/planOps')
const { Agenda } = require('../src/engine/agenda')
const { unplannedFocus } = require('../src/engine/tasks')

const run = (a, body, by = 'self') => apply(a, parse(body), by)
const fresh = () => { state.agenda = new Agenda(); return state.agenda }

test('a focused goal with no route needs planning', () => {
  const a = fresh()
  run(a, 'push:get diamonds')
  assert.strictEqual(unplannedFocus()?.id, 'g1')
})

test('a planned route reaching an unplanned subgoal needs planning for that subgoal', () => {
  const a = fresh()
  run(a, 'push:get diamonds')
  run(a, 'strat:g1:mine them needs=iron_pickaxe (have 0) pack=torches, food')
  run(a, 'sub:s2:iron_pickaxe')
  assert.strictEqual(unplannedFocus()?.id, 'g3')
  run(a, 'strat:g3:craft it needs=3 iron_ingot (have 3), 2 sticks (have 2) pack=none')
  assert.strictEqual(unplannedFocus(), null)   // now a leaf to act on
})

test('nothing to plan: empty agenda, a goal waiting for a verdict, an ongoing order', () => {
  let a = fresh()
  assert.strictEqual(unplannedFocus(), null)
  run(a, 'push:x')
  run(a, 'strat:g1:y needs=none pack=none')
  run(a, 'done:s2')
  assert.strictEqual(unplannedFocus(), null)   // route done: the goal waits for done/another route
  a = fresh()
  a.push('follow Sargon564', { owner: 'Sargon564', ongoing: true })
  assert.strictEqual(unplannedFocus(), null)
})
