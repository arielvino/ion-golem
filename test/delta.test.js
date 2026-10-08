// DELTA= (src/ai/delta.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { snapshot, renderDelta } = require('../src/ai/delta')

const base = { pos: { x: 108.5, y: 118, z: 108.5 }, hp: 19, food: 20, held: 'stone_pickaxe', offhand: 'nothing',
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
    'held stone_pickaxe→copper_pickaxe | task idle→bg:goto | new nearby: zombie | gone from nearby: Sargon564')
})

test('a shield moved to the off-hand reads as moved, not lost', () => {
  const a = snapshot({ ...base, inv: { stone_pickaxe: 1, dirt: 3, shield: 1 } })
  const b = snapshot({ ...base, offhand: 'shield', now: 3000 })
  assert.strictEqual(renderDelta(a, b), 'since last turn (2s): -1 shield | offhand nothing→shield')
})

test('a running task is the same task while only its timer moves', () => {
  const a = snapshot({ ...base, task: 'bg:goto:1,2,3 (0s, cardinal walking toward 1,2,3)' })
  const b = snapshot({ ...base, task: 'bg:goto:1,2,3 (13s, cardinal walking toward 1,2,3)', now: 14000 })
  assert.strictEqual(renderDelta(a, b), 'nothing changed in 13s')
  const c = snapshot({ ...base, task: 'bg:goto:1,2,3 (22s, tunneling toward 1,2,3)', now: 23000 })
  assert.match(renderDelta(b, c), /task bg:goto:1,2,3 \(cardinal walking toward 1,2,3\)→bg:goto:1,2,3 \(tunneling toward 1,2,3\)/)
})

test('entities are told apart by tag; a crowd collapses; a drop pile growing is reported', () => {
  const a = snapshot({ ...base, seen: ['cow#a3f9', 'drop:cobblestone#0c1d'], drops: { 'drop:cobblestone#0c1d': 2 } })
  const b = snapshot({ ...base, seen: ['cow#77e2', 'cod#1b2c', 'cod#2d3e', 'cod#9e01', 'drop:cobblestone#0c1d'],
    drops: { 'drop:cobblestone#0c1d': 5 }, now: 6000 })
  assert.strictEqual(renderDelta(a, b),
    'since last turn (5s): new nearby: cod×3, cow#77e2 | gone from nearby: cow#a3f9 | drop:cobblestone#0c1d x2→x5')
})

test('a player walking off while staying in view is a change', () => {
  const a = snapshot({ ...base, players: { Sargon564: 2 } })
  const b = snapshot({ ...base, players: { Sargon564: 17 }, now: 12000 })
  assert.strictEqual(renderDelta(a, b), 'since last turn (11s): Sargon564 2m→17m away')
  assert.strictEqual(renderDelta(a, snapshot({ ...base, players: { Sargon564: 4 }, now: 12000 })), 'nothing changed in 11s')
})

test('far threats: one wandering in is quiet, a crowd gathering is reported', () => {
  const a = snapshot({ ...base, far: { skeleton: 3 } })
  assert.strictEqual(renderDelta(a, snapshot({ ...base, far: { skeleton: 4, zombie: 2 }, now: 4000 })), 'nothing changed in 3s')
  assert.strictEqual(renderDelta(a, snapshot({ ...base, far: { skeleton: 7, zombie: 3 }, now: 4000 })),
    'since last turn (3s): far skeleton×3→7, zombie×0→3')
})
