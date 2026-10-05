// Entity tags (src/perception/entityTag.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { entityTag, tagOf, findTagged } = require('../src/perception/entityTag')

const cow1 = { id: 7, name: 'cow', uuid: 'A3F9C0DE-0000-4000-8000-000000000001' }
const cow2 = { id: 8, name: 'cow', uuid: '77e21111-0000-4000-8000-000000000002' }
const pile = { id: 9, name: 'item', uuid: '0c1d2222-0000-4000-8000-000000000003', getDroppedItem: () => ({ name: 'cobblestone', count: 5 }) }
const orb = { id: 12, name: 'experience_orb' }
const player = { id: 3, name: 'player', username: 'Sargon564', uuid: 'ffff0000-0000-4000-8000-000000000004' }

test('tags are the first 4 uuid hex digits; drops name their item; players keep their name', () => {
  assert.deepStrictEqual([cow1, cow2, pile, orb, player].map(entityTag),
    ['cow#a3f9', 'cow#77e2', 'drop:cobblestone#0c1d', 'experience_orb#e12', 'Sargon564'])
})

test('a tagged spec finds that exact entity; untagged specs are not tags', () => {
  const self = { id: 1 }
  state.bot = { entity: self, entities: { 1: self, 3: player, 7: cow1, 8: cow2, 9: pile } }
  assert.strictEqual(findTagged('cow#77e2'), cow2)
  assert.strictEqual(findTagged('#a3f9'), cow1)
  assert.strictEqual(findTagged('cow#dead'), null)
  assert.strictEqual(tagOf('cow'), null)
})
