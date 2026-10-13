// Damage causes (src/perception/damageCause.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { damageCause, hasAttacker } = require('../src/perception/damageCause')

test('a damage type is named in words; none is an unknown source', () => {
  assert.strictEqual(damageCause('in_wall'), 'suffocating inside a block')
  assert.strictEqual(damageCause('fall'), 'a fall')
  assert.strictEqual(damageCause('some_new_type'), 'some new type')
  assert.strictEqual(damageCause(undefined), 'an unknown source')
})

test('only attack types, or an unnamed type, can have an attacker', () => {
  assert.strictEqual(hasAttacker('mob_attack'), true)
  assert.strictEqual(hasAttacker('arrow'), true)
  assert.strictEqual(hasAttacker(undefined), true)
  assert.strictEqual(hasAttacker('fall'), false)
  assert.strictEqual(hasAttacker('in_wall'), false)
})
