// Unit tests for doors.js door geometry. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { blocksAxis } = require('../src/navigation/doors')
const { isOpenable } = require('../src/config/blocks')

const door = (name, props) => ({ name, getProperties: () => props })

test('a closed door facing north/south blocks only z travel', () => {
  const d = door('oak_door', { facing: 'north', open: false, half: 'lower' })
  assert.equal(blocksAxis(d, 'z'), true)
  assert.equal(blocksAxis(d, 'x'), false)
})

test('opening a door swings it 90°: it now blocks x, not z', () => {
  const d = door('oak_door', { facing: 'south', open: true, half: 'lower' })
  assert.equal(blocksAxis(d, 'z'), false)
  assert.equal(blocksAxis(d, 'x'), true)
})

test('an east/west door blocks x when closed', () => {
  assert.equal(blocksAxis(door('spruce_door', { facing: 'east', open: false }), 'x'), true)
  assert.equal(blocksAxis(door('spruce_door', { facing: 'east', open: false }), 'z'), false)
})

test('a closed fence gate blocks everything, an open one nothing', () => {
  assert.equal(blocksAxis(door('oak_fence_gate', { facing: 'north', open: false }), 'x'), true)
  assert.equal(blocksAxis(door('oak_fence_gate', { facing: 'north', open: false }), 'z'), true)
  assert.equal(blocksAxis(door('oak_fence_gate', { facing: 'north', open: true }), 'z'), false)
})

test('wooden doors and gates open by hand; iron doors and trapdoors are not doorways', () => {
  assert.ok(isOpenable('oak_door'))
  assert.ok(isOpenable('crimson_fence_gate'))
  assert.ok(!isOpenable('iron_door'))
  assert.ok(!isOpenable('oak_trapdoor'))
  assert.ok(!isOpenable('oak_fence'))
  assert.ok(!isOpenable(null))
})
