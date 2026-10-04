// Unit tests for light-aware sight (castRays on a hand-built cube). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { castRays, skyDarken } = require('../src/perception/sight')

const R = 6, side = 2 * R + 1
const AIR = 0, STONE = 1, GLOWSTONE = 2
const opaque = new Uint8Array(1 << 16); opaque[STONE] = 1; opaque[GLOWSTONE] = 1
const emits = new Uint8Array(1 << 16); emits[GLOWSTONE] = 1
const idx = (x, y, z) => ((y + R) * side + (z + R)) * side + (x + R)   // relative to the eye cell

// Eye in the middle of cell (0,0,0); a stone wall filling the plane x = +4.
function scene({ lightAll = 0, withLight = true } = {}) {
  const snap = new Uint16Array(side ** 3)
  const light = withLight ? new Uint8Array(side ** 3).fill(lightAll) : null
  for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) snap[idx(4, y, z)] = STONE
  return { snap, light, side, ox: R + 0.5, oy: R + 0.5, oz: R + 0.5 }
}
const sees = (cube, x, y, z) => castRays(cube, opaque, R, emits).seen[idx(x, y, z)] === 1

test('lit wall is seen', () => {
  assert.ok(sees(scene({ lightAll: 15 }), 4, 0, 0))
})

test('wall in the dark is not seen', () => {
  assert.ok(!sees(scene({ lightAll: 0 }), 4, 0, 0))
})

test('lit face seen through dark air between', () => {
  const c = scene()
  c.light[idx(3, 0, 0)] = 8                       // only the cell in front of the face
  assert.ok(sees(c, 4, 0, 0))
  assert.ok(c.light[idx(1, 0, 0)] === 0 && c.light[idx(2, 0, 0)] === 0)
})

test('wall lit only on its far side stays dark', () => {
  const c = scene()
  c.light[idx(5, 0, 0)] = 15
  assert.ok(!sees(c, 4, 0, 0))
})

test('light source shows in the dark', () => {
  const c = scene()
  c.snap[idx(4, 0, 0)] = GLOWSTONE
  assert.ok(sees(c, 4, 0, 0))
})

test('dark plant is hidden, lit plant is seen', () => {
  const GRASS = 3                                  // not opaque: lit by its own cell
  const c = scene()
  c.snap[idx(2, 0, 0)] = GRASS
  assert.ok(!sees(c, 2, 0, 0))
  c.light[idx(2, 0, 0)] = 5
  assert.ok(sees(c, 2, 0, 0))
})

test('no light data: everything a ray reaches is seen', () => {
  assert.ok(sees(scene({ withLight: false }), 4, 0, 0))
})

test('sky darkening follows the day', () => {
  assert.strictEqual(skyDarken(6000), 0)          // noon
  assert.strictEqual(skyDarken(18000), 11)        // midnight: sky 15 → 4 (moonlight)
  assert.strictEqual(skyDarken(6000, 1), 3)       // rain by day
  assert.ok(skyDarken(13000) > 0 && skyDarken(13000) < 11)   // dusk
})
