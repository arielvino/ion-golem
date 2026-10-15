// Unit tests for footing memory (src/perception/footing.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { touchedCells } = require('../src/perception/footing')

// BotEvt, 2026-10-14: after pillaring up 151→157 the block DB had 155, 154, 152 and
// 151 as air. pillarUp never recorded its blocks and vision can't see under the
// bot's own feet, so standing on a block has to be enough to know it.
test('standing on a full block: the block underneath, feet and head', () => {
  assert.deepStrictEqual(touchedCells(new Vec3(5.5, 157, 3.5), true), [[5, 156, 3], [5, 157, 3], [5, 158, 3]])
})

test('in the air nothing underneath is touched', () => {
  assert.deepStrictEqual(touchedCells(new Vec3(5.5, 157.4, 3.5), false), [[5, 157, 3], [5, 158, 3], [5, 159, 3]])
})

test('on a slab the support is the body\'s own lowest cell', () => {
  assert.deepStrictEqual(touchedCells(new Vec3(-0.5, 64.5, 0.5), true), [[-1, 64, 0], [-1, 65, 0], [-1, 66, 0]])
})
