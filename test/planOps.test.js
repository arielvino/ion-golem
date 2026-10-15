// Unit tests for [PLAN:...] parsing and application (src/engine/planOps.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { parse, apply } = require('../src/engine/planOps')
const { Agenda } = require('../src/engine/agenda')

const run = (a, body, by = 'Sargon') => apply(a, parse(body), by)

test('parse: free text is the last field and may contain colons', () => {
  assert.deepStrictEqual(parse('push:say hi: loudly'), { op: 'push', text: 'say hi: loudly' })
  assert.deepStrictEqual(parse('strat:g1:craft it needs=x pack=none'), { op: 'strat', id: 'g1', text: 'craft it', needs: 'x', pack: 'none' })
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
  run(a, 'strat:g1:craft needs=x pack=none', 'self')                  // s2 active
  run(a, 'strat:g1:loot a village chest needs=x pack=none', 'self')   // s3 dormant
  run(a, 'sub:s2:3 iron_ingot', 'self')             // g4
  run(a, 'sub:s2:2 stick', 'self')                  // g5
  run(a, 'strat:g4:mine and smelt needs=x pack=none', 'self')         // s6 leaf
  assert.match(a.render(), /s6 STRAT mine and smelt \[active\] ← act/)
  run(a, 'done:s6', 'self')
  assert.match(a.render(), /g4 GOAL 3 iron_ingot \[open\] ← route done: done:g4 if achieved, else another route/)
  run(a, 'done:g4', 'self')
  run(a, 'done:g5', 'self')
  assert.match(a.render(), /s2 STRAT craft \[active\] ← steps done: add the next, or done:s2/)
  run(a, 'done:s2', 'self')
  assert.match(a.render(), /g1 GOAL iron_pickaxe for Sargon \[open\].* ← route done: done:g1/)
  run(a, 'done:g1', 'self')
  assert.strictEqual(a.entries.length, 0) // pruned
})

// The dragon run (2026-10-15): one reply replaced a subgoal whose target turned out
// wrong. fail:g22 used to fail s2 and with it the root, so sub:s2 hung the new step on
// a dead route and the dragon goal sat failed.
test('apply: fail a subgoal then sub a replacement keeps the route and the root alive', () => {
  const a = new Agenda()
  run(a, 'push:kill the ender dragon'); run(a, 'strat:g1:gear up then go to the End needs=x pack=none', 'self')
  run(a, 'sub:s2:iron gear: mine iron at -70,16,564', 'self')     // g3
  run(a, 'fail:g3', 'self')
  run(a, 'sub:s2:iron gear: mine deepslate iron at -41,-54,586', 'self')  // g4
  assert.strictEqual(a.tree.nodes.get('g1').status, 'open')
  assert.strictEqual(a.tree.nodes.get('s2').status, 'active')
  assert.strictEqual(a.focus().id, 'g1')
  assert.match(a.render(), /g4 GOAL iron gear: mine deepslate iron at -41,-54,586 \[open\] ← plan a route/)
})

test('apply: done on a strategy with unfinished subgoals is refused', () => {
  const a = new Agenda()
  run(a, 'push:x'); run(a, 'strat:g1:y needs=x pack=none'); run(a, 'sub:s2:z')
  assert.throws(() => run(a, 'done:s2'), /s2 still has subgoals to finish: g3/)
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
  run(a, 'push:x'); run(a, 'strat:g1:a needs=x pack=none'); run(a, 'strat:g1:b needs=x pack=none')
  run(a, 'fail:s2', 'self')
  assert.match(a.render(), /← choose strategy/)
  run(a, 'use:s3', 'self')
  assert.strictEqual(a.tree.nodes.get('g1').active, 's3')
})

test('apply: reopen only takes goals; unknown ids are reported', () => {
  const a = new Agenda()
  run(a, 'push:x'); run(a, 'strat:g1:a needs=x pack=none')
  assert.throws(() => run(a, 'reopen:s2'), /reopen takes a goal/)
  assert.throws(() => run(a, 'done:g9'), /no node g9/)
})

test('apply: "new" names what this reply created, so a goal and its route fit one turn', () => {
  const a = new Agenda()
  const made = {}
  const reply = (body) => apply(a, parse(body), 'Sargon', made)
  reply('push:give Sargon a stone_pickaxe')
  assert.match(reply('strat:new:craft it needs=x pack=none'), /^strat s2 .* for g1 \(active\)$/)
  assert.match(reply('sub:new:wooden_pickaxe'), /^sub g3 .* under s2$/)
  assert.match(reply('strat:new:craft it from planks needs=x pack=none'), /for g3/)
  assert.strictEqual(reply('fail:new'), 'fail s4')
})

test('apply: "new" with nothing created this reply is reported, not guessed', () => {
  const a = new Agenda()
  run(a, 'push:dig a hole')
  assert.throws(() => run(a, 'strat:new:shovel it needs=x pack=none'), /"new" means a goal created earlier in this same reply — there is none/)
})

// Bro, 2026-10-14 20:04: after the only subgoal finished, the model reopened the
// root and gave it a new route, but the next turn still saw the finished route
// as active and the new one dormant, with its subgoal hidden.
test('apply: a route added to a reopened goal takes over from the finished one', () => {
  const a = new Agenda()
  run(a, 'push:kill the ender dragon')                         // g1
  run(a, 'strat:g1:gear up chain needs=x pack=none', 'self')                     // s2 active
  run(a, 'sub:s2:wood tools and crafting table', 'self')       // g3
  run(a, 'done:g3', 'self')
  run(a, 'done:s2', 'self')                                    // s2 done, g1 verify
  const reply = {}                                             // one reply, as the model sent it
  for (const body of ['reopen:g1', 'strat:g1:full chain from wood tier needs=x pack=none', 'sub:new:stone_pickaxe and cobblestone']) {
    apply(a, parse(body), 'self', reply)                       // s4, then g5
  }
  const t = a.tree
  assert.strictEqual(t.nodes.get('s4').status, 'active')
  assert.deepStrictEqual(t.activePath('g1').map(n => n.id), ['g1', 's4', 'g5'])
  assert.match(t.render('g1'), /g5 GOAL stone_pickaxe and cobblestone \[open\]/)
})

test('apply: reopening a goal whose route finished asks for a route, not the dead one', () => {
  const a = new Agenda()
  run(a, 'push:kill the ender dragon')
  run(a, 'strat:g1:gear up chain needs=x pack=none', 'self')
  run(a, 'sub:s2:wood tools', 'self')
  run(a, 'done:g3', 'self')
  run(a, 'done:s2', 'self')
  run(a, 'reopen:g1', 'self')
  assert.deepStrictEqual(a.tree.activePath('g1').map(n => n.id), ['g1'])
  assert.match(a.tree.render('g1'), /g1 GOAL kill the ender dragon \[open\].*← choose strategy/)
})

test('parse: strat needs a route walked through — needs= and pack= are required', () => {
  assert.throws(() => parse('strat:g1:craft it'), /strat needs the route walked through first/)
  assert.throws(() => parse('strat:g1:craft it needs=3 iron_ingot'), /strat needs the route walked through first/)
  assert.throws(() => parse('strat:g1:craft it needs= pack=none'), /strat needs the route walked through first/)
  assert.deepStrictEqual(parse('strat:g1:staircase to y-54: strip mine needs=iron_pickaxe (have), torches (have 0) pack=16 torches, 10 bread'),
    { op: 'strat', id: 'g1', text: 'staircase to y-54: strip mine', needs: 'iron_pickaxe (have), torches (have 0)', pack: '16 torches, 10 bread' })
})

test('apply: a strategy keeps its needs and pack, and the tree shows them on the active route', () => {
  const a = new Agenda()
  run(a, 'push:diamonds')
  run(a, 'strat:g1:staircase down and strip mine needs=iron_pickaxe (have) pack=16 torches, food', 'self')
  run(a, 'strat:g1:loot a chest needs=nothing pack=none', 'self')
  assert.strictEqual(a.tree.nodes.get('s2').pack, '16 torches, food')
  const view = a.tree.render('g1')
  assert.match(view, /s2 STRAT staircase down and strip mine \[active\][^\n]*\n\s+needs: iron_pickaxe \(have\) \| pack: 16 torches, food/)
  assert.doesNotMatch(view, /needs: nothing/)   // dormant routes stay one-liners
})

test('render: a goal with no route asks for one', () => {
  const a = new Agenda()
  run(a, 'push:get diamonds')
  assert.match(a.tree.render('g1'), /g1 GOAL get diamonds \[open\].*← plan a route/)
})
