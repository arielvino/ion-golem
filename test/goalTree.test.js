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
  assert.deepStrictEqual(t.activePath('g1').map(n => n.id), ['g1', 's2', 'g4', 's6', 'g7', 's8'])
  assert.deepStrictEqual(t.stackView('g1').map(e => e.t), ['give Sargon an iron_pickaxe', '3 iron_ingot', '3 raw_iron'])
})

test('model verdicts on subgoals do not roll up; each level waits for its own', () => {
  const { t, ingots, sticks, smelt, craft, root } = pickaxeTree()
  t.markGoal(sticks.id, 'done')
  assert.throws(() => t.completeStrategy(craft.id), /still has subgoals to finish: g4/)
  t.markGoal(ingots.id, 'done')
  // both subgoals done, but the route may have more steps: the model says when it is finished
  assert.strictEqual(craft.status, 'active')
  assert.strictEqual(root.status, 'open')
  t.completeStrategy(craft.id)
  assert.strictEqual(craft.status, 'done')
  assert.strictEqual(root.status, 'open')     // the route finished; the goal waits for the model
  assert.match(t.render('g1'), /g1 GOAL .*\[open\].* ← route done: done:g1 if achieved, else another route/)
  assert.strictEqual(smelt.status, 'active') // untouched: the model judged ingots done directly
  t.markGoal(root.id, 'done')
  assert.strictEqual(root.status, 'done')
})

test('a finished leaf strategy never marks its goal done by itself', () => {
  const { t, mine, raw, smelt } = pickaxeTree()
  t.completeStrategy(mine.id)
  assert.strictEqual(raw.status, 'open')
  assert.strictEqual(smelt.status, 'active')
  assert.match(t.render('g1'), /g7 GOAL 3 raw_iron \[open\] ← route done: done:g7 if achieved, else another route/)
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
  assert.match(t.render('g1'), /g7 GOAL 3 raw_iron \[open\].*← choose strategy/)
  t.activate(cave.id)
  assert.strictEqual(t.activePath('g1').at(-1).id, cave.id)
})

test('failure never propagates: every route failing leaves the goal open for the model', () => {
  const { t, raw, mine, cave, smelt, ingots, craft, root } = pickaxeTree()
  t.failStrategy(mine.id)
  t.failStrategy(cave.id)
  assert.strictEqual(raw.status, 'open')
  assert.strictEqual(smelt.status, 'active')
  assert.strictEqual(ingots.status, 'open')
  assert.strictEqual(craft.status, 'active')
  assert.strictEqual(root.status, 'open')
  assert.match(t.render('g1'), /g7 GOAL 3 raw_iron \[open\] ← every route failed: add another, or fail:g7/)
})

// The dragon run (2026-10-15): the model failed a subgoal to replace it, and the
// failure took the strategy and the root goal down with it.
test('failing a subgoal leaves its strategy alive for a replacement step', () => {
  const { t, raw, smelt, ingots, root } = pickaxeTree()
  t.markGoal(raw.id, 'failed')
  assert.strictEqual(smelt.status, 'active')
  assert.strictEqual(ingots.status, 'open')
  assert.strictEqual(root.status, 'open')
  assert.match(t.render('g1'), /s6 STRAT smelt raw iron \[active\] ← steps done, g7 failed: add the next or a replacement, or done:s6 \/ fail:s6/)
  const other = t.addGoal(smelt.id, { text: '3 raw_iron from the deepslate vein' })
  assert.strictEqual(t.activePath('g1').at(-1).id, other.id)
  t.markGoal(other.id, 'done')
  t.completeStrategy(smelt.id)                 // a failed step doesn't block finishing the route
  assert.strictEqual(smelt.status, 'done')
})

test('steps waiting on a failed sibling are pointed out', () => {
  const t = new GoalTree()
  const r = t.addGoal(null, { text: 'pickaxe' })
  const s = t.addStrategy(r.id, { text: 'craft' })
  const planks = t.addGoal(s.id, { text: 'planks' })
  t.addGoal(s.id, { text: 'pickaxe', after: [planks.id] })
  t.markGoal(planks.id, 'failed')
  assert.match(t.render(r.id), /s2 STRAT craft \[active\] ← steps wait on failed g3: add a replacement, or fail:s2/)
})

test('failing a goal is only that goal', () => {
  const { t, ingots, craft, root } = pickaxeTree()
  t.markGoal(ingots.id, 'failed')
  assert.strictEqual(craft.status, 'active')
  assert.strictEqual(root.status, 'open')
  t.markGoal(root.id, 'failed')
  assert.strictEqual(root.status, 'failed')
})

test('cannot activate a failed strategy', () => {
  const { t, mine } = pickaxeTree()
  t.failStrategy(mine.id)
  assert.throws(() => t.activate(mine.id), /failed/)
})

test('a finished route asks the model to judge its goal; not achieved → pick another route', () => {
  const t = new GoalTree()
  const r = t.addGoal(null, { text: 'find a village' })
  const s = t.addStrategy(r.id, { text: 'walk east' })
  t.completeStrategy(s.id)
  assert.strictEqual(r.status, 'open')
  assert.match(t.render('g1'), /← route done: done:g1 if achieved, else another route/)
  const n = t.addStrategy(r.id, { text: 'walk north' })   // model: not really
  assert.strictEqual(n.status, 'active')
  assert.strictEqual(s.status, 'done')
  assert.strictEqual(t.activePath('g1').at(-1).id, n.id)
})

test('a stored goal in the retired verify status loads as open', () => {
  const t = GoalTree.fromJSON({ seq: 2, nodes: [
    { id: 'g1', kind: 'goal', text: 'x', reason: '', status: 'verify', parent: null, strategies: ['s2'], active: 's2', after: [] },
    { id: 's2', kind: 'strategy', text: 'y', parent: 'g1', status: 'done', goals: [], est: null }] })
  assert.strictEqual(t.nodes.get('g1').status, 'open')
  assert.match(t.render('g1'), /← route done: done:g1/)
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

test('render shows the active path and one-line siblings only', () => {
  const { t } = pickaxeTree()
  const out = t.render('g1')
  assert.match(out, /^g1 GOAL give Sargon an iron_pickaxe \[open\] \{Sargon asked\}/)
  assert.match(out, /s3 dormant loot a village chest \(conf 0\.3\)/)
  assert.match(out, /g5 open 2 stick/)
  assert.match(out, /s8 STRAT strip-mine at y15 \[active\] ← act/)
  assert.match(out, /s9 dormant cave-surface ore/)
})

test('a new strategy revives a failed goal: the model has another way to try', () => {
  const { t, root, raw } = pickaxeTree()
  t.markGoal(root.id, 'failed')
  const trade = t.addStrategy(root.id, { text: 'trade with a villager' })
  assert.strictEqual(root.status, 'open')
  assert.strictEqual(root.active, 's2')                     // craft is still the active route
  assert.strictEqual(trade.status, 'dormant')
  t.markGoal(raw.id, 'failed')
  const ask = t.addStrategy(raw.id, { text: 'ask a player' })
  assert.strictEqual(raw.status, 'open')
  assert.strictEqual(ask.status, 'dormant')
})

test('removeRoot deletes the whole subtree', () => {
  const { t, root } = pickaxeTree()
  const other = t.addGoal(null, { text: 'other' })
  t.removeRoot(root.id)
  assert.deepStrictEqual([...t.nodes.keys()], [other.id])
  assert.deepStrictEqual(t.roots().map(r => r.id), [other.id])
})

test('JSON round-trip preserves structure and id sequence', () => {
  const { t } = pickaxeTree()
  const t2 = GoalTree.fromJSON(JSON.parse(JSON.stringify(t)))
  assert.strictEqual(t2.render('g1'), t.render('g1'))
  assert.strictEqual(t2.addGoal(null, { text: 'next' }).id, 'g10')
})

test('a goal with no routes yet offers acting directly', () => {
  const t = new GoalTree()
  const g = t.addGoal(null, { text: 'come to Sargon564' })
  assert.match(t.render(g.id), /GOAL come to Sargon564 \[open\] ← act, or plan routes$/)
})

// Bro, 2026-10-14 20:04: the model planned "gear up chain: wood, stone, iron, …"
// and, as told, decomposed one level: only the wood subgoal. Finishing it closed
// the whole route and sent the dragon goal to verify.
test('a route whose subgoals are all done waits for the next step, not done by itself', () => {
  const t = new GoalTree()
  const root = t.addGoal(null, { text: 'kill the ender dragon' })
  const chain = t.addStrategy(root.id, { text: 'gear up chain: wood, stone, iron' })
  const wood = t.addGoal(chain.id, { text: 'wood tools and crafting table' })
  t.markGoal(wood.id, 'done')
  assert.strictEqual(chain.status, 'active')
  assert.strictEqual(root.status, 'open')
  assert.match(t.render(root.id), /s2 STRAT gear up chain: wood, stone, iron \[active\] ← steps done: add the next, or done:s2/)
  const stone = t.addGoal(chain.id, { text: 'stone_pickaxe' })
  assert.deepStrictEqual(t.activePath(root.id).map(n => n.id), ['g1', 's2', stone.id])
})
