// nearby= (src/ai/nearby.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const state = require('../src/core/state')
const { renderNearby } = require('../src/ai/nearby')

state.bot = { registry: require('prismarine-registry')('26.1') }

const here = new Vec3(0, 64, 0)
const RANGES = { threats: 40, mobs: 24, drops: 32 }
let n = 0
// A mob `d` blocks due east, with a uuid whose first 4 hex digits become its tag.
const mob = (name, d, extra = {}) => ({ name, uuid: `${(0xa000 + n++).toString(16)}0000-0000`, position: new Vec3(d, 64, 0), ...extra })

test('close mobs get tags; far ones are counted per kind after far:', () => {
  const r = renderNearby([
    mob('sheep', 30), mob('sheep', 10), mob('zombie', 35), mob('sheep', 60),
    mob('skeleton', 50, { equipment: [{ name: 'bow' }] }), mob('skeleton', 90),
  ], here, RANGES)
  assert.match(r.text, /^sheep#a001@10,64,0\(10m\), zombie#a002@35,64,0\(35m\), far: sheep×2\(30m\+\), skeleton×2\(50m\+\)$/)
  assert.deepStrictEqual(r.seen, ['sheep#a001', 'zombie#a002'])
  assert.deepStrictEqual(r.far, { skeleton: 2 })
})

test('a threat is tagged farther out than a passive mob', () => {
  const r = renderNearby([mob('creeper', 31), mob('cow', 31)], here, RANGES)
  assert.match(r.text, /^creeper#\w{4}@31,64,0\(31m\), far: cow×1\(31m\+\)$/)
})

test('background mobs stay one count per kind, before far:', () => {
  const r = renderNearby([mob('squid', 5), mob('squid', 80), mob('pig', 100)], here, RANGES)
  assert.strictEqual(r.text, 'squid×2(5m+), far: pig×1(100m+)')
  assert.deepStrictEqual(r.seen, ['squid'])
})

test('drops are listed within pickup range only, with stack size', () => {
  const drop = (d, count) => mob('item', d, { getDroppedItem: () => ({ name: 'cobblestone', count }) })
  const r = renderNearby([drop(5, 3), drop(50, 9)], here, RANGES)
  assert.match(r.text, /^drop:cobblestone#\w{4}@5,64,0\(5m,x3\)$/)
  assert.deepStrictEqual(Object.values(r.drops), [3])
})

test('nothing visible → none', () => {
  assert.strictEqual(renderNearby([], here, RANGES).text, 'none')
})
