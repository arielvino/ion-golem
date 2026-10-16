// When the engine asks for a [PLAN-FIRST] turn: the focus reached a goal it can't act on yet.
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
  assert.strictEqual(unplannedFocus()?.goal.id, 'g1')
})

test('a planned route reaching an unplanned subgoal needs planning for that subgoal', () => {
  const a = fresh()
  run(a, 'push:get diamonds')
  run(a, 'strat:g1:mine them needs=iron_pickaxe (have 0) pack=torches, food lack=iron_pickaxe, torches, food')
  run(a, 'sub:s2:iron_pickaxe')
  assert.strictEqual(unplannedFocus()?.goal.id, 'g3')
  run(a, 'strat:g3:craft it needs=3 iron_ingot (have 3), 2 sticks (have 2) pack=none lack=none')
  assert.strictEqual(unplannedFocus(), null)   // now a leaf to act on
})

test('nothing to plan: empty agenda, a goal waiting for a verdict, an ongoing order', () => {
  let a = fresh()
  assert.strictEqual(unplannedFocus(), null)
  run(a, 'push:x')
  run(a, 'strat:g1:y needs=none pack=none lack=none')
  run(a, 'done:s2')
  assert.strictEqual(unplannedFocus(), null)   // route done: the goal waits for done/another route
  a = fresh()
  a.push('follow Sargon564', { owner: 'Sargon564', ongoing: true })
  assert.strictEqual(unplannedFocus(), null)
})

test('a route that lacks something with no subgoal for it needs planning', () => {
  const a = fresh()
  run(a, 'push:get diamonds')
  run(a, 'strat:g1:strip mine needs=iron_pickaxe (have) pack=food lack=food')
  assert.deepStrictEqual(unplannedFocus(), { goal: a.tree.nodes.get('g1'), why: 'route s2 lacks food and has no subgoal to get it' })
})

test('after a death the topmost stale route is planned first', () => {
  const a = fresh()
  run(a, 'push:get diamonds')
  run(a, 'strat:g1:mine them needs=x pack=none lack=iron_pickaxe')
  run(a, 'sub:s2:iron_pickaxe')
  run(a, 'strat:g3:craft it needs=x pack=none lack=none')
  a.tree.markStale('you died')
  assert.strictEqual(unplannedFocus()?.goal.id, 'g1')
  run(a, 'use:s2')
  assert.strictEqual(unplannedFocus()?.goal.id, 'g3')
  run(a, 'use:s4')
  assert.strictEqual(unplannedFocus(), null)
})
