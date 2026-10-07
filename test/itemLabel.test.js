// Unit tests for the durability label in the context blob. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { itemLabel } = require('../src/ai/context')

const registry = require('minecraft-data')('26.1')
const Item = require('prismarine-item')(registry)
// As it arrives off the wire on 26.1: damage lives in the item's components.
const wire = (name, damage) => Item.fromNotch({
  itemId: registry.itemsByName[name].id, itemCount: 1,
  components: damage === undefined ? [] : [{ type: 'damage', data: damage }], removeComponents: []
})

test('damageable item shows remaining/max from its damage component', () => {
  assert.equal(itemLabel(wire('iron_pickaxe', 38)), 'iron_pickaxe(212/250)')
  assert.equal(itemLabel(wire('diamond_chestplate', 500)), `diamond_chestplate(${registry.itemsByName.diamond_chestplate.maxDurability - 500}/${registry.itemsByName.diamond_chestplate.maxDurability})`)
})

test('undamaged tool reads full; inventory form drops the x1 count', () => {
  assert.equal(itemLabel(wire('wooden_pickaxe'), true), 'wooden_pickaxe(59/59)')
})

test('stackables keep the count, empty slot reads nothing', () => {
  const cobble = new Item(registry.itemsByName.cobblestone.id, 12)
  assert.equal(itemLabel(cobble, true), 'cobblestonex12')
  assert.equal(itemLabel(cobble), 'cobblestone')
  assert.equal(itemLabel(null), 'nothing')
})
