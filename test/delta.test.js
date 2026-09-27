// DELTA= (src/ai/delta.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { snapshot, renderDelta } = require('../src/ai/delta')

const base = { pos: { x: 108.5, y: 118, z: 108.5 }, hp: 19, food: 20, held: 'stone_pickaxe',
  inv: { stone_pickaxe: 1, dirt: 3 }, armor: [], vehicle: 'ON_FOOT', task: 'idle', seen: ['Sargon564', 'cow'], now: 1000 }

test('no previous turn → no delta; identical → says nothing changed', () => {
  const a = snapshot(base)
  assert.strictEqual(renderDelta(null, a), '')
  assert.strictEqual(renderDelta(a, snapshot({ ...base, now: 6000 })), 'nothing changed in 5s')
})

test('a fall, an item change and a mob coming into view read as one line', () => {
  const a = snapshot(base)
  const b = snapshot({ ...base, pos: { x: 109.2, y: 101, z: 108.7 }, hp: 5, inv: { stone_pickaxe: 1, dirt: 1, copper_pickaxe: 1 },
    held: 'copper_pickaxe', task: 'bg:goto', seen: ['cow', 'zombie'], now: 13000 })
  assert.strictEqual(renderDelta(a, b),
    'since last turn (12s): moved 108,118,108→109,101,108 (17m, -17y) | HP 19→5 | -2 dirt, +1 copper_pickaxe | ' +
    'held stone_pickaxe→copper_pickaxe | task idle→bg:goto | in view: zombie | out of view: Sargon564')
})
