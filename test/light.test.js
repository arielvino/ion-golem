// Unit tests for the light gate the vision paths share. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const mcData = require('minecraft-data')('26.1')
const { lightGate } = require('../src/perception/light')

const MIN_Y = -64
// A bot whose world gives each cell the light lightAt(x, y, z) → { block, sky }.
function makeBot(lightAt, { dimension = 'minecraft:overworld', timeOfDay = 6000 } = {}) {
  const sections = (kind, cx, cz) => Array.from({ length: 26 }, (_, s) => ({
    get: (i) => lightAt(cx * 16 + (i & 15), MIN_Y + (s - 1) * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15))[kind],
  }))
  return {
    game: { dimension, minY: MIN_Y },
    time: { timeOfDay },
    registry: mcData,
    world: { getColumn: (cx, cz) => ({ blockLightSections: sections('block', cx, cz), skyLightSections: sections('sky', cx, cz) }) },
  }
}
const dark = () => ({ block: 0, sky: 0 })
const sid = (name) => mcData.blocksByName[name].minStateId

test('outside the overworld nothing is gated', () => {
  assert.equal(lightGate(makeBot(dark, { dimension: 'minecraft:the_nether' })), null)
  assert.equal(lightGate(makeBot(dark, { dimension: 'minecraft:the_end' })), null)
})

test('a cell is lit by block light, and reads the right cell, negative coords included', () => {
  const g = lightGate(makeBot((x, y, z) => ({ block: x === -3 && y === 20 && z === -17 ? 7 : 0, sky: 0 })))
  assert.ok(g.lit(-3, 20, -17))
  assert.ok(!g.lit(-2, 20, -17))
  assert.ok(!g.lit(-3, 21, -17))
  assert.ok(!g.lit(-3, 20, -16))
})

test('open sky is lit at noon and at midnight, shade at midnight is not', () => {
  const sky = (level) => () => ({ block: 0, sky: level })
  assert.ok(lightGate(makeBot(sky(15), { timeOfDay: 6000 })).lit(0, 70, 0))
  assert.ok(lightGate(makeBot(sky(15), { timeOfDay: 18000 })).lit(0, 70, 0))    // 15 - 11
  assert.ok(!lightGate(makeBot(sky(11), { timeOfDay: 18000 })).lit(0, 70, 0))
  assert.ok(lightGate(makeBot(sky(11), { timeOfDay: 6000 })).lit(0, 70, 0))
})

test('faceLit: a solid block goes by the face cell, a see-through one by its own, a light source always shows', () => {
  const g = lightGate(makeBot((x) => ({ block: x === 1 ? 10 : 0, sky: 0 })))
  const stone = g.faceLit(sid('stone'), 0, 0, 0)
  assert.ok(stone(1, 0, 0))                       // lit face
  assert.ok(!stone(-1, 0, 0))                     // dark face
  const water = g.faceLit(sid('water'), 0, 0, 0)
  assert.ok(!water(1, 0, 0))                      // its own cell is dark, whatever the front
  assert.ok(g.faceLit(sid('water'), 1, 0, 0)(0, 0, 0))
  assert.equal(g.faceLit(sid('glowstone'), 0, 0, 0), null)
  assert.equal(g.faceLit(sid('torch'), 0, 0, 0), null)
})
