// Suspected caves from one ray-cast view (perception/caves.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const mcData = require('minecraft-data')('26.1')
const { castRays, opaqueTable, waterTable } = require('../src/perception/sight')
const { suspectCaves, noteDug } = require('../src/perception/caves')

const R = 20, side = 2 * R + 1, GROUND = R - 2     // local y of the top ground block
const sid = (name) => mcData.blocksByName[name].minStateId
const opaque = opaqueTable(mcData), water = waterTable(mcData)

// A cube centred on the eye (standing on GROUND), fully lit; build(set) shapes it.
function view(build, { x0 = 1000, y0 = 40, z0 = 1000 } = {}) {
  const snap = new Uint16Array(side * side * side), light = new Uint8Array(side * side * side).fill(15)
  const set = (x, y, z, name) => { snap[(y * side + z) * side + x] = sid(name) }
  for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) for (let y = 0; y <= GROUND; y++) set(x, y, z, 'stone')
  build(set)
  const cube = { snap, light, side, x0, y0, z0, ox: R + 0.5, oy: GROUND + 1 + 1.62, oz: R + 0.5 }
  const { seen, dry } = castRays(cube, opaque, R, null, water)
  return suspectCaves(mcData, cube, seen, dry, opaque)
}

// A rock hill east of the eye with a hollow in it, open toward the eye.
function hillCave(set, mouth = 'air') {
  for (let x = R + 6; x < R + 16; x++) for (let z = R - 6; z <= R + 6; z++) for (let y = GROUND + 1; y <= GROUND + 7; y++) set(x, y, z, 'stone')
  for (let x = R + 6; x < R + 14; x++) for (let z = R - 3; z <= R + 3; z++) for (let y = GROUND + 1; y <= GROUND + 3; y++) set(x, y, z, x === R + 6 ? mouth : 'air')
}

test('flat open ground has no cave', () => {
  assert.deepStrictEqual(view(() => {}), [])
})

test('a hollow in a hill, open toward the eye, is a cave', () => {
  const caves = view((set) => hillCave(set))
  // Parts of its ceiling are out of sight from outside, so it can come in more than one piece.
  assert.ok(caves.length >= 1)
  assert.ok(caves[0].cells >= 20, `cells ${caves[0].cells}`)
  assert.strictEqual(caves[0].at.x, 1000 + R + 6)        // nearest first, its nearest cell: the mouth
  assert.strictEqual(caves[0].dist, 6)
})

test('a crack in the ground at your feet, 3+ deep below both rims, is a cave', () => {
  const crack = (deep) => view((set) => {
    for (const x of [R + 1, R + 2]) for (let z = R - 6; z <= R + 6; z++) for (let y = GROUND - deep + 1; y <= GROUND; y++) set(x, y, z, 'air')
  })
  const caves = crack(8)
  assert.strictEqual(caves.length, 1)
  assert.ok(caves[0].cells >= 20, `cells ${caves[0].cells}`)
  assert.deepStrictEqual(crack(2), [])                   // a shallow ditch is not
})

test('a cave seen only through water is not reported', () => {
  assert.deepStrictEqual(view((set) => hillCave(set, 'water')), [])
})

test('a roof of planks or leaves is no cave', () => {
  const roofed = (roof) => view((set) => {
    for (let x = R + 4; x <= R + 9; x++) for (let z = R - 3; z <= R + 3; z++) set(x, GROUND + 4, z, roof)
  })
  assert.deepStrictEqual(roofed('oak_planks'), [])
  assert.deepStrictEqual(roofed('oak_leaves'), [])
})

test('cells the bot dug itself are no cave', () => {
  const origin = { x0: 5000, y0: 40, z0: 5000 }
  for (let x = R + 6; x < R + 14; x++) for (let z = R - 3; z <= R + 3; z++) for (let y = GROUND + 1; y <= GROUND + 3; y++) {
    noteDug({ x: origin.x0 + x, y: origin.y0 + y, z: origin.z0 + z })
  }
  assert.deepStrictEqual(view((set) => hillCave(set), origin), [])
})

test('underground (rock overhead) nothing is reported', () => {
  assert.deepStrictEqual(view((set) => {
    hillCave(set)
    for (let x = R - 2; x <= R + 2; x++) for (let z = R - 2; z <= R + 2; z++) set(x, GROUND + 4, z, 'stone')
  }), [])
})
