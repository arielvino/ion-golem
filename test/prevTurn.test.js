// PREV=: the last turn in one line, shown at the top of the next one.
const test = require('node:test')
const assert = require('node:assert')
const { formatPrevTurn } = require('../src/world/journalStore')

test('a turn that acted: trigger, why, actions, plan edits, errors and what was said', () => {
  assert.strictEqual(formatPrevTurn({
    turn: 11, trigger: 'SELF-CHECK', why: 'logs first; used=inv', actions: ['mine:log:4', 'craft:oak_planks:4'],
    plan: ['strat s4 "punch logs" for g3 (active)'], planErrors: 1, said: 'Tree  first.',
  }), '#11 SELF-CHECK | why: logs first; used=inv | did: mine:log:4, craft:oak_planks:4 | plan: strat s4 "punch logs" for g3 (active) | 1 plan error (PLAN_ERR) | said: "Tree first."')
})

test('a turn that did nothing says so', () => {
  assert.strictEqual(formatPrevTurn({ turn: 3, trigger: 'MONITOR', said: 'Still walking.' }), '#3 MONITOR | did: nothing | said: "Still walking."')
})

test('a turn with no reply says why', () => {
  assert.strictEqual(formatPrevTurn({ turn: 7, trigger: 'Sargon564 spoke', outcome: 'interrupted before the reply ended' }),
    '#7 Sargon564 spoke | interrupted before the reply ended')
})

test('the trigger is who spoke, else the engine tags', () => {
  const { turnTrigger } = require('../src/ai/ai')
  const isPlayer = (u) => u !== 'self' && u !== 'event'
  assert.strictEqual(turnTrigger([{ username: 'self', message: '[SELF-CHECK] task="x"' }, { username: 'Sargon564', message: 'come' }], isPlayer), 'Sargon564 spoke')
  assert.strictEqual(turnTrigger([{ username: 'self', message: '[PLAN-FIRST] goal=g3 "x"' }, { username: 'event', message: '[GAME EVENT] [BOOT] You (Bro) just started up' }], isPlayer), 'PLAN-FIRST, GAME EVENT')
})
