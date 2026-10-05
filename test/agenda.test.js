// Unit tests for the agenda (src/engine/agenda.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Agenda } = require('../src/engine/agenda')
const { GoalTreeError } = require('../src/engine/goalTree')

const SARGON = { owner: 'Sargon', reason: 'Sargon asked' }

test('push interrupts on top; queue waits at the bottom', () => {
  const a = new Agenda()
  const pick = a.push('iron_pickaxe for Sargon', SARGON)
  const house = a.queue('build a house', SARGON)
  const night = a.push('survive the night', { owner: 'self' })
  assert.deepStrictEqual(a.entries.map(e => e.id), [night.id, pick.id, house.id])
  assert.strictEqual(a.focus().id, night.id)
})

test('an entry needs an owner', () => {
  assert.throws(() => new Agenda().push('x'), /owner/)
})

test('move reorders, clamped to the list', () => {
  const a = new Agenda()
  const x = a.queue('x', SARGON), y = a.queue('y', SARGON), z = a.queue('z', SARGON)
  a.move(z.id, 0)
  assert.deepStrictEqual(a.entries.map(e => e.id), [z.id, x.id, y.id])
  a.move(z.id, 99)
  assert.deepStrictEqual(a.entries.map(e => e.id), [x.id, y.id, z.id])
})

test('a suspended goal keeps its tree and resumes where it left off', () => {
  const a = new Agenda()
  const pick = a.push('iron_pickaxe for Sargon', SARGON)
  const craft = a.tree.addStrategy(pick.id, { text: 'craft' })
  const ingots = a.tree.addGoal(craft.id, { text: '3 iron_ingot' })
  const mine = a.tree.addStrategy(ingots.id, { text: 'strip-mine at y15' })

  const night = a.push('survive the night', { owner: 'self' })
  a.tree.addStrategy(night.id, { text: 'dig in and wait' })
  assert.match(a.render(), new RegExp(`${pick.id} iron_pickaxe for Sargon \\[open\\] \\{Sargon\\} — suspended at ${mine.id} strip-mine at y15`))

  a.tree.markGoal(night.id, 'done')
  assert.deepStrictEqual(a.prune().map(e => e.id), [night.id])
  assert.strictEqual(a.focus().id, pick.id)
  assert.strictEqual(a.tree.activePath(pick.id).at(-1).id, mine.id)
  assert.ok(!a.tree.nodes.has(night.id))
})

test('focus skips failed roots, which stay listed until dealt with', () => {
  const a = new Agenda()
  const pick = a.push('iron_pickaxe for Sargon', SARGON)
  const house = a.queue('build a house', SARGON)
  a.tree.failStrategy(a.tree.addStrategy(pick.id, { text: 'craft' }).id)
  assert.strictEqual(a.focus().id, house.id)
  assert.match(a.render(), /failed\] \{Sargon\} ← failed: new strategy or ask Sargon/)
  a.tree.addStrategy(pick.id, { text: 'trade' })
  assert.strictEqual(a.focus().id, pick.id)
})

test('a goal awaiting verification keeps focus', () => {
  const a = new Agenda()
  const r = a.push('find a village', SARGON)
  a.queue('later', SARGON)
  a.tree.completeStrategy(a.tree.addStrategy(r.id, { text: 'walk east' }).id)
  assert.strictEqual(a.focus().id, r.id)
})

test("only the owner can cancel a player's goal; the bot can cancel its own", () => {
  const a = new Agenda()
  const pick = a.push('iron_pickaxe for Sargon', SARGON)
  const wander = a.push('explore', { owner: 'self' })
  assert.throws(() => a.cancel(pick.id, 'self'), GoalTreeError)
  assert.throws(() => a.cancel(pick.id, 'Steve'), /only they can cancel/)
  a.cancel(wander.id, 'self')
  a.cancel(pick.id, 'Sargon')
  assert.strictEqual(a.entries.length, 0)
  assert.strictEqual(a.tree.nodes.size, 0)
})

test('stackView is the active path through the focused tree only', () => {
  const a = new Agenda()
  a.push('build a house', SARGON)
  const pick = a.push('iron_pickaxe for Sargon', SARGON)
  const craft = a.tree.addStrategy(pick.id, { text: 'craft' })
  a.tree.addGoal(craft.id, { text: '3 iron_ingot' })
  assert.deepStrictEqual(a.stackView().map(e => e.t), ['iron_pickaxe for Sargon', '3 iron_ingot'])
  assert.deepStrictEqual(new Agenda().stackView(), [])
})

test('ongoing is shown; render is empty with no entries', () => {
  const a = new Agenda()
  assert.strictEqual(a.render(), '')
  a.push('guard the base', { owner: 'Sargon', ongoing: true })
  assert.match(a.render(), /guard the base \[open\] \{Sargon,ongoing\}/)
})

test('JSON round-trip keeps order, ownership and trees', () => {
  const a = new Agenda()
  const pick = a.push('iron_pickaxe for Sargon', SARGON)
  a.tree.addStrategy(pick.id, { text: 'craft' })
  a.queue('guard', { owner: 'self', ongoing: true })
  const b = Agenda.fromJSON(JSON.parse(JSON.stringify(a)))
  assert.strictEqual(b.render(), a.render())
  assert.throws(() => b.cancel(pick.id, 'self'), /only they/)
})
