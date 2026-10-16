// Pickup range: the server hands an item over when the player's hitbox, grown by 1
// sideways and 0.5 up/down, touches the item's.
const test = require('node:test')
const assert = require('node:assert')
const { inPickupRange } = require('../src/actions/pickup')

const at = (x, y, z) => ({ x, y, z })

test('a drop at the back of a one-high nook is out of range from the middle of the next cell', () => {
  // Bro at -19,110,-60, the jungle_log at the back of the nook in -20,110,-60.
  assert.strictEqual(inPickupRange(at(-18.5, 110, -59.5), at(-19.995, 110, -59.157)), false)
})

test('stepping up against the nook brings it in range', () => {
  assert.strictEqual(inPickupRange(at(-18.7, 110, -59.5), at(-19.995, 110, -59.157)), true)
})

test('height: up to 0.5 below the feet and 0.5 above the head', () => {
  assert.strictEqual(inPickupRange(at(0.5, 64, 0.5), at(0.5, 63.3, 0.5)), true)
  assert.strictEqual(inPickupRange(at(0.5, 64, 0.5), at(0.5, 63.2, 0.5)), false)
  assert.strictEqual(inPickupRange(at(0.5, 64, 0.5), at(0.5, 66.2, 0.5)), true)
  assert.strictEqual(inPickupRange(at(0.5, 64, 0.5), at(0.5, 66.4, 0.5)), false)
})
