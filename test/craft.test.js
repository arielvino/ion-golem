// Unit tests for the craft action: it crafts the one item asked for, never a chain of
// intermediates. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { doCraft } = require('../src/actions/crafting')

// A bot holding `items`, with mineflayer's recipesFor reduced to: only the items named in
// `craftableNow` can be crafted from the inventory. Every craft call is recorded.
const registry = require('minecraft-data')('26.1')
function botWith(items, craftableNow = []) {
  const craftableIds = new Set(craftableNow.map(n => registry.itemsByName[n].id))
  const crafted = []
  return {
    crafted,
    version: '26.1',
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => items.map(([name, count]) => ({ name, count })), slots: [] },
    recipesFor: (id) => craftableIds.has(id) ? [{}] : [],
    craft: async (recipe, count) => { crafted.push({ recipe, count }) },
  }
}

function setup(items, craftableNow) {
  const bot = botWith(items, craftableNow)
  state.bot = bot
  state.chatMuted = true
  state.lastFailures = []
  state.actionQueue = []
  return bot
}

test('sticks from logs alone: no auto-crafted planks, the failure names the planks step', async () => {
  const bot = setup([['oak_log', 4]], ['oak_planks'])
  assert.equal(await doCraft('stick'), false)
  assert.deepEqual(bot.crafted, [], 'nothing crafted on the way')
  const fail = state.lastFailures.at(-1)
  assert.match(fail, /^craft:stick - missing: any_planks\(need 2, have 0; craft:oak_planks first\)/)
})

test('an ingredient the inventory cannot make gets no craft hint', async () => {
  const bot = setup([['raw_iron', 3]])
  assert.equal(await doCraft('iron_nugget'), false)
  assert.deepEqual(bot.crafted, [])
  assert.match(state.lastFailures.at(-1), /iron_ingot\(need 1, have 0\)/)
})
