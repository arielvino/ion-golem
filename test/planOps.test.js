// Unit tests for [PLAN:...] parsing and application (src/engine/planOps.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { parse, apply } = require('../src/engine/planOps')
const { Agenda } = require('../src/engine/agenda')

const run = (a, body, by = 'Sargon') => apply(a, parse(body), by)

test('parse: free text is the last field and may contain colons', () => {
  assert.deepStrictEqual(parse('push:say hi: loudly'), { op: 'push', text: 'say hi: loudly' })
  assert.deepStrictEqual(parse('strat:g1:craft it'), { op: 'strat', id: 'g1', text: 'craft it' })
})

test('parse: {reason} on push/queue, after= on sub', () => {
  assert.deepStrictEqual(parse('queue:build a house {wants a base}'), { op: 'queue', text: 'build a house', reason: 'wants a base' })
  assert.deepStrictEqual(parse('sub:s2:wooden_pickaxe after=g3, g4'), { op: 'sub', id: 's2', text: 'wooden_pickaxe', after: ['g3', 'g4'] })
})

test('parse: errors name the valid shapes', () => {
  assert.throws(() => parse('pop'), /unknown op "pop" — have: push, queue/)
  assert.throws(() => parse('strat:g1'), /strat needs <id>:<text>/)
  assert.throws(() => parse('move:g1:top'), /index must be a number/)
})

test('apply: the speaker owns what they push and gets a default reason', () => {
  const a = new Agenda()
  run(a, 'push:iron_pickaxe for me')
  run(a, 'push:survive the night', 'self')
  assert.deepStrictEqual(a.entries.map(e => e.owner), ['self', 'Sargon'])
  assert.strictEqual(a.tree.nodes.get('g1').reason, 'Sargon asked')
  assert.strictEqual(a.tree.nodes.get('g2').reason, '')
})

test('apply: a full build-out, one level per turn, to a finished goal', () => {
  const a = new Agenda()
  run(a, 'push:iron_pickaxe for Sargon')            // g1
  run(a, 'strat:g1:craft', 'self')                  // s2 active
  run(a, 'strat:g1:loot a village chest', 'self')   // s3 dormant
  run(a, 'sub:s2:3 iron_ingot', 'self')             // g4
  run(a, 'sub:s2:2 stick', 'self')                  // g5
  run(a, 'strat:g4:mine and smelt', 'self')         // s6 leaf
  assert.match(a.render(), /s6 STRAT mine and smelt \[active\] ← act/)
  run(a, 'done:s6', 'self')
  assert.match(a.render(), /g4 GOAL 3 iron_ingot \[verify\] ← confirm done\?/)
  run(a, 'done:g4', 'self')
  run(a, 'done:g5', 'self')
  assert.match(a.render(), /g1 GOAL iron_pickaxe for Sargon \[verify\]/)
  run(a, 'done:g1', 'self')
  assert.strictEqual(a.entries.length, 0) // pruned
})

test('apply: done on a non-leaf strategy is refused', () => {
  const a = new Agenda()
  run(a, 'push:x'); run(a, 'strat:g1:y'); run(a, 'sub:s2:z')
  assert.throws(() => run(a, 'done:s2'), /has subgoals/)
})

test('apply: a self turn cannot cancel a player goal, the player can', () => {
  const a = new Agenda()
  run(a, 'push:guard the base')
  assert.throws(() => run(a, 'cancel:g1', 'self'), /only they can cancel/)
  run(a, 'cancel:g1', 'Sargon')
  assert.strictEqual(a.entries.length, 0)
})

test('apply: fail then use a dormant route', () => {
  const a = new Agenda()
  run(a, 'push:x'); run(a, 'strat:g1:a'); run(a, 'strat:g1:b')
  run(a, 'fail:s2', 'self')
  assert.match(a.render(), /← choose strategy/)
  run(a, 'use:s3', 'self')
  assert.strictEqual(a.tree.nodes.get('g1').active, 's3')
})

test('apply: reopen only takes goals; unknown ids are reported', () => {
  const a = new Agenda()
  run(a, 'push:x'); run(a, 'strat:g1:a')
  assert.throws(() => run(a, 'reopen:s2'), /reopen takes a goal/)
  assert.throws(() => run(a, 'done:g9'), /no node g9/)
})
