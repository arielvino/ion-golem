// Unit tests for the goal tree (src/engine/goalTree.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { GoalTree, GoalTreeError } = require('../src/engine/goalTree')

// The iron-pickaxe tree from BRAIN_PLAN.md §3, trimmed.
function pickaxeTree() {
  const t = new GoalTree()
  const root = t.addGoal(null, { text: 'give Sargon an iron_pickaxe', reason: 'Sargon asked' })
  const craft = t.addStrategy(root.id, { text: 'craft', est: { min: 15, conf: 0.8 } })
  const loot = t.addStrategy(root.id, { text: 'loot a village chest', est: { conf: 0.3 } })
  const ingots = t.addGoal(craft.id, { text: '3 iron_ingot' })
  const sticks = t.addGoal(craft.id, { text: '2 stick' })
  const smelt = t.addStrategy(ingots.id, { text: 'smelt raw iron' })
  const raw = t.addGoal(smelt.id, { text: '3 raw_iron' })
  const mine = t.addStrategy(raw.id, { text: 'strip-mine at y15' })
  const cave = t.addStrategy(raw.id, { text: 'cave-surface ore' })
  return { t, root, craft, loot, ingots, sticks, smelt, raw, mine, cave }
}

test('first strategy auto-activates; later ones stay dormant', () => {
  const { craft, loot } = pickaxeTree()
  assert.strictEqual(craft.status, 'active')
  assert.strictEqual(loot.status, 'dormant')
})

test('active path descends to the leaf strategy', () => {
  const { t } = pickaxeTree()
  assert.deepStrictEqual(t.activePath().map(n => n.id), ['g1', 's2', 'g4', 's6', 'g7', 's8'])
  assert.deepStrictEqual(t.stackView().map(e => e.t), ['give Sargon an iron_pickaxe', '3 iron_ingot', '3 raw_iron'])
})

test('model verdicts on subgoals roll up; the parent goal still waits for its own', () => {
  const { t, ingots, sticks, smelt, craft, root } = pickaxeTree()
  t.markGoal(sticks.id, 'done')
  assert.strictEqual(craft.status, 'active')
  t.markGoal(ingots.id, 'done')
  // craft had both subgoals done → done; the root is not assumed done
  assert.strictEqual(craft.status, 'done')
  assert.strictEqual(root.status, 'verify')
  assert.strictEqual(smelt.status, 'active') // untouched: the model judged ingots done directly
  t.markGoal(root.id, 'done')
  assert.strictEqual(t.focus(), null)
})

test('a finished leaf strategy never marks its goal done by itself', () => {
  const { t, mine, raw, smelt } = pickaxeTree()
  t.completeStrategy(mine.id)
  assert.strictEqual(raw.status, 'verify')
  assert.strictEqual(smelt.status, 'active')
  assert.match(t.render(), /g7 GOAL 3 raw_iron \[verify\] ← confirm done\?/)
})

test('switching strategy keeps the old one dormant', () => {
  const { t, craft, loot, root } = pickaxeTree()
  t.activate(loot.id)
  assert.strictEqual(root.active, loot.id)
  assert.strictEqual(craft.status, 'dormant')
  t.activate(craft.id)
  assert.strictEqual(loot.status, 'dormant')
})

test('failing a strategy leaves the choice to the model while alternatives exist', () => {
  const { t, raw, mine, cave } = pickaxeTree()
  t.failStrategy(mine.id)
  assert.strictEqual(raw.status, 'open')
  assert.strictEqual(raw.active, null)
  assert.match(t.render(), /g7 GOAL 3 raw_iron \[open\].*← choose strategy/)
  t.activate(cave.id)
  assert.strictEqual(t.activePath().at(-1).id, cave.id)
})

test('failure propagates up until a goal with a surviving alternative', () => {
  const { t, raw, mine, cave, smelt, ingots, craft, root, loot } = pickaxeTree()
  t.failStrategy(mine.id)
  t.failStrategy(cave.id)
  assert.strictEqual(raw.status, 'failed')
  assert.strictEqual(smelt.status, 'failed')
  assert.strictEqual(ingots.status, 'failed') // smelt was its only strategy
  assert.strictEqual(craft.status, 'failed')
  assert.strictEqual(root.status, 'open')    // loot is still dormant
  assert.strictEqual(root.active, null)
  assert.strictEqual(loot.status, 'dormant')
})

test('cannot activate a failed strategy', () => {
  const { t, mine } = pickaxeTree()
  t.failStrategy(mine.id)
  assert.throws(() => t.activate(mine.id), /failed/)
})

test('a leaf strategy completing asks the model to verify a model-judged goal', () => {
  const t = new GoalTree()
  const r = t.addGoal(null, { text: 'find a village' })
  const s = t.addStrategy(r.id, { text: 'walk east' })
  t.completeStrategy(s.id)
  assert.strictEqual(r.status, 'verify')
  assert.match(t.render(), /confirm done\?/)
  t.markGoal(r.id, 'open') // model: not really
  assert.strictEqual(r.status, 'open')
})

test('after: edges gate subgoal order', () => {
  const t = new GoalTree()
  const r = t.addGoal(null, { text: 'wooden_pickaxe' })
  const s = t.addStrategy(r.id, { text: 'craft' })
  const table = t.addGoal(s.id, { text: 'crafting_table' })
  const planks = t.addGoal(s.id, { text: 'planks', after: [] })
  const pick = t.addGoal(s.id, { text: 'pickaxe', after: [table.id, planks.id] })
  assert.deepStrictEqual(t.actionable(s.id).map(g => g.id), [table.id, planks.id])
  t.markGoal(table.id, 'done')
  t.markGoal(planks.id, 'done')
  assert.deepStrictEqual(t.actionable(s.id).map(g => g.id), [pick.id])
  assert.throws(() => t.addGoal(s.id, { text: 'x', after: ['g99'] }), /not a sibling/)
})

test('focus is the newest open root', () => {
  const t = new GoalTree()
  const a = t.addGoal(null, { text: 'a' })
  const b = t.addGoal(null, { text: 'b' })
  assert.strictEqual(t.focus().id, b.id)
  t.markGoal(b.id, 'done')
  assert.strictEqual(t.focus().id, a.id)
})

test('render shows the active path and one-line siblings only', () => {
  const { t } = pickaxeTree()
  const out = t.render()
  assert.match(out, /^g1 GOAL give Sargon an iron_pickaxe \[open\] \{Sargon asked\}/)
  assert.match(out, /s3 dormant loot a village chest \(conf 0\.3\)/)
  assert.match(out, /g5 open 2 stick/)
  assert.match(out, /s8 STRAT strip-mine at y15 \[active\] ← act/)
  assert.match(out, /s9 dormant cave-surface ore/)
})

test('JSON round-trip preserves structure and id sequence', () => {
  const { t } = pickaxeTree()
  const t2 = GoalTree.fromJSON(JSON.parse(JSON.stringify(t)))
  assert.strictEqual(t2.render(), t.render())
  assert.strictEqual(t2.addGoal(null, { text: 'next' }).id, 'g10')
})
