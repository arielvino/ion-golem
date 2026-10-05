// Unit tests for touch.js (reach + line of sight before using a block). Run: node --test
process.env.PERCEPTION_SLOW = '1'   // plain blockAt LOS path; the mock world has no columns
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const state = require('../src/core/state')
const { reachDistance, canTouch, REACH } = require('../src/perception/touch')

// worldMap: "x,y,z" -> block name; everything absent is air. The bot stands at `pos`.
function setWorld(worldMap, pos) {
  state.bot = {
    version: '26.1',
    entity: { position: pos, eyeHeight: 1.62 },
    blockAt: (v) => ({ name: worldMap.get(`${v.x},${v.y},${v.z}`) || 'air', position: v }),
  }
}

test('reachDistance measures eye to the nearest point of the block', () => {
  const eye = new Vec3(0.5, 1.62, 0.5)
  assert.equal(reachDistance(eye, 0, 1, 0), 0)                 // eye inside the cell
  assert.ok(Math.abs(reachDistance(eye, 3, 1, 0) - 2.5) < 1e-9) // face 2.5 away
  assert.ok(Math.abs(reachDistance(eye, 0, -1, 0) - 1.62) < 1e-9) // block under the feet
})

test('a buried furnace straight below: in reach, but behind 2 blocks of stone', () => {
  const world = new Map([['0,99,0', 'stone'], ['0,98,0', 'stone'], ['0,97,0', 'furnace']])
  setWorld(world, new Vec3(0.5, 100, 0.5))
  const t = canTouch(new Vec3(0, 97, 0))
  assert.equal(t.ok, false)
  assert.equal(t.reason, 'not_visible')
})

test('the same furnace with the stone gone can be touched', () => {
  setWorld(new Map([['0,97,0', 'furnace']]), new Vec3(0.5, 100, 0.5))
  assert.equal(canTouch(new Vec3(0, 97, 0)).ok, true)
})

test('a furnace one block deeper is out of reach (eye to its top face 4.62m)', () => {
  setWorld(new Map([['0,96,0', 'furnace']]), new Vec3(0.5, 100, 0.5))
  const t = canTouch(new Vec3(0, 96, 0))
  assert.equal(t.reason, 'out_of_reach')
  assert.ok(t.dist > REACH)
})

test('the copper case: in vanilla reach (4.40m) though mineflayer\'s canDigBlock (centre > 5.1m) refused it', () => {
  // Bot feet at 100.5,100,100.5; ore at 104,98,101 in an open pit.
  setWorld(new Map([['104,98,101', 'copper_ore']]), new Vec3(100.5, 100, 100.5))
  const t = canTouch(new Vec3(104, 98, 101))
  assert.equal(t.ok, true)
  assert.ok(t.dist < REACH && t.dist > 4.3)
})

test('one block further the ore is out of reach', () => {
  setWorld(new Map([['105,98,101', 'copper_ore']]), new Vec3(100.5, 100, 100.5))
  assert.equal(canTouch(new Vec3(105, 98, 101)).reason, 'out_of_reach')
})

test('a visible ore within reach can be touched', () => {
  setWorld(new Map([['102,99,100', 'copper_ore']]), new Vec3(100.5, 100, 100.5))
  assert.equal(canTouch(new Vec3(102, 99, 100)).ok, true)
})

test('glass can be seen through but not clicked through', () => {
  setWorld(new Map([['0,99,0', 'glass'], ['0,98,0', 'chest']]), new Vec3(0.5, 100, 0.5))
  assert.equal(canTouch(new Vec3(0, 98, 0)).reason, 'not_visible')
})

test('a click goes through water', () => {
  setWorld(new Map([['0,99,0', 'water'], ['0,98,0', 'chest']]), new Vec3(0.5, 100, 0.5))
  assert.equal(canTouch(new Vec3(0, 98, 0)).ok, true)
})
