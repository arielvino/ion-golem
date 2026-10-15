// Fall measurement for digdown/jumpdown and [CTX:around] (src/navigation/fall.js), against a
// throwaway DB built with the real schema. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const state = require('../src/core/state')
const memory = require('../src/world/memory')
const { measureFall, neighbourFall, damageOf } = require('../src/navigation/fall')

state.WORLD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'descend-'))
memory.initDB()
const put = (x, y, z, name) => state.stmts.upsertBlock.run(x, y, z, name, 0, null)
const column = (x, z, fromY, toY, name) => { for (let y = fromY; y <= toY; y++) put(x, y, z, name) }

// A dirt pillar 110..117 at (0,0) over air down to a stone floor at y100; the
// columns around it are open air from 101 up. The pillar's underside (0,109,0)
// was never seen.
column(0, 0, 110, 117, 'dirt')
for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { column(x, z, 101, 118, 'air'); put(x, 100, z, 'stone') }
// Water pool beside at (5,0): air 101..105, water at 100.
column(5, 0, 101, 105, 'air'); put(5, 100, 0, 'water')

test('a fall through known air lands on the first solid block', () => {
  const f = measureFall(1, 118, 0)
  assert.deepStrictEqual([f.blocks, f.landing, f.at, !!f.unknown], [17, 'stone', 100, false])
  assert.strictEqual(damageOf(f), 14)
})

test('breaking the floor counts it as open; an unseen cell stops the scan', () => {
  const f = measureFall(0, 111, 0, 1)   // standing on 110, floor 110 opened
  assert.deepStrictEqual([f.blocks, !!f.unknown, f.at], [1, true, 109])
})

test('open columns beside a hidden underside give an estimated drop', () => {
  const est = neighbourFall(0, 110, 0)
  assert.deepStrictEqual([est.blocks, est.landing, est.estimated], [10, 'stone', true])
  assert.strictEqual(damageOf(est), 7)
  // Only an upper bound: from the top the neighbours are open all the way down,
  // though the pillar itself continues under the floor.
  assert.strictEqual(neighbourFall(0, 117, 0).blocks, 17)
})

test('water landings do no damage', () => {
  const f = measureFall(5, 106, 0)
  assert.deepStrictEqual([f.blocks, f.water, damageOf(f)], [5, true, 0])
})

// digdown's rule (src/actions/descend.js floorVerdict): never dig straight down onto
// a block it hasn't seen. Bro, 2026-10-14: a digdown through unseen ground opened an
// underground water pocket and trapped it in its own 1x1 shaft.
const { floorVerdict } = require('../src/actions/descend')
// Solid ground at (20,0): only the top block at y60 was ever seen.
put(20, 60, 0, 'stone')
// Known stone floor at (30,0) with known water under it.
put(30, 60, 0, 'stone'); put(30, 59, 0, 'water')

test('digdown: down a known pillar is fine', () => {
  assert.strictEqual(floorVerdict({ x: 0, y: 118, z: 0 }), null)   // 116 is known dirt
})

test('digdown: refuses a floor whose underside was never seen', () => {
  const why = floorVerdict({ x: 20, y: 61, z: 0 })
  assert.match(why, /block under the floor \(y59\) was never seen/)
  assert.match(why, /staircase/)
})

test('digdown: an unseen underside with open columns beside points to jumpdown', () => {
  const why = floorVerdict({ x: 0, y: 111, z: 0 })                 // the pillar's last block
  assert.match(why, /never seen.*columns beside it are open: about 10 blocks onto stone.*jumpdown:down/)
})

test('digdown: known water under the floor stops it', () => {
  assert.match(floorVerdict({ x: 30, y: 61, z: 0 }), /water under the floor at y59/)
})
