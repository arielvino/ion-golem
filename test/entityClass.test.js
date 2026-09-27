const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { entityClass } = require('../src/perception/entityClass')

state.bot = { registry: require('prismarine-registry')('26.1') }

test('entityClass: fish, squid and bats are background', () => {
  for (const name of ['cod', 'tropical_fish', 'squid', 'glow_squid', 'dolphin', 'bat']) {
    assert.equal(entityClass({ name }), 'background', name)
  }
})

test('entityClass: hostile-typed and listed mobs are threats', () => {
  for (const name of ['zombie', 'creeper', 'drowned', 'slime', 'phantom', 'hoglin']) {
    assert.equal(entityClass({ name }), 'threat', name)
  }
})

test('entityClass: persistent and unknown entities are tracked; items are drops', () => {
  for (const name of ['cow', 'wolf', 'villager', 'iron_golem', 'oak_boat', 'some_future_mob']) {
    assert.equal(entityClass({ name }), 'tracked', name)
  }
  assert.equal(entityClass({ name: 'item' }), 'drop')
})
