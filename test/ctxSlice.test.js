// Unit tests for the CTX slice provider, focused on thick= slab projection. Run: node --test
//
// These run against a synthetic on-disk block DB rather than a live world, because the
// behaviour under test is a ranking rule over cells whose ground truth has to be known
// exactly. The live DB of a fresh surface world contains no ore and no hazards at all,
// so the $ / ! / notable / tie-break paths are precisely the ones it cannot exercise.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')

const state = require('../src/core/state')

// Scene, centred on a bot at (0,65,0) with axis=ew — so the cross-axis is z and a
// z-offset is depth into the slab. Stone fills z=-4..4 so every cell has some record.
//   coal_ore    (3,63,2)   z+2: invisible to thick=1, found by thick>=5
//   lava        (-2,62,-1) z-1: found by thick>=3
//   diamond_ore (5,61,0) + lava (5,61,2): one column-depth, two planes. Hazard must win
//               the glyph, and the ore must still survive in the notable list.
//   iron_ore    (-5,64,1) + (-5,64,2): one column-depth, both ore. Nearer plane wins.
// Every fixture sits inside the thick=5 slab (z=-2..2); anything outside it is correctly
// invisible, which is the constraint that caught the first draft of this file.
const FIXTURES = [
  [3, 63, 2, 'coal_ore'],
  [-2, 62, -1, 'lava'],
  [5, 61, 0, 'diamond_ore'],
  [5, 61, 2, 'lava'],
  [-5, 64, 1, 'iron_ore'],
  [-5, 64, 2, 'iron_ore'],
]

let dir, PROVIDERS

test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxslice-'))
  state.BOT_DATA_DIR = dir

  const Database = require('better-sqlite3')
  const db = new Database(path.join(dir, 'blocks.db'))
  db.exec(`CREATE TABLE blocks (x INTEGER, y INTEGER, z INTEGER, name TEXT NOT NULL,
           seen_at INTEGER NOT NULL, PRIMARY KEY (x,y,z));`)
  const ins = db.prepare('INSERT OR REPLACE INTO blocks VALUES (?,?,?,?,0)')
  db.transaction(() => {
    for (let x = -8; x <= 8; x++)
      for (let y = 60; y <= 70; y++)
        for (let z = -4; z <= 4; z++)
          ins.run(x, y, z, y > 65 ? 'air' : 'stone')
    for (const f of FIXTURES) ins.run(...f)
  })()
  db.close()

  require('../src/world/memory').initDB()
  state.bot = { entity: { position: new Vec3(0, 65, 0) }, inventory: { items: () => [] } }
  PROVIDERS = require('../src/ai/ctxProviders').PROVIDERS
})

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {} })

const render = (thick) => PROVIDERS.slice.render(['ew', '8', String(thick)])
const gridRows = (s) => s.split('\n').filter((l) => /^\s*-?\d+ /.test(l))
// Grid columns run x=-8..8 after the y label, so x maps to index x+8.
const glyphAt = (s, y, x) => {
  const row = gridRows(s).find((l) => l.trim().startsWith(`${y} `))
  return row.replace(/^\s*-?\d+ /, '')[x + 8]
}

test('a thin slice misses what a thick one catches', () => {
  const thin = render(1)
  assert.ok(!thin.includes('coal_ore'), 'coal is one block off-axis, must be invisible')
  assert.ok(!thin.includes('lava'), 'that lava is one block off-axis too')

  assert.ok(render(5).includes('coal_ore'), 'thick=5 must reach z+2')
  assert.ok(render(3).includes('lava'), 'thick=3 must reach z-1')
})

test('found blocks are reported at their true off-axis coordinates', () => {
  // Flattening the slab destroys depth, so the coordinate annex is the only thing that
  // can turn "there is coal in here somewhere" into a goto.
  assert.match(render(5), /coal_ore x1 nearest@3,63,2/)
})

test('hazards outrank ores in a shared column-depth, without losing the ore', () => {
  const t5 = render(5)
  assert.strictEqual(glyphAt(t5, 61, 5), '!', 'lava must win the glyph over diamond_ore')
  assert.ok(t5.includes('diamond_ore'), 'the outranked ore must still appear in notable')
})

test('ties are broken toward the plane nearest the bot', () => {
  assert.match(render(5), /iron_ore x2 nearest@-5,64,1/)
})

test('output size is driven by radius, not by thickness', () => {
  // The whole reason for projecting instead of stacking: thickness costs N times the DB
  // query but the same tokens. Stacking N grids would multiply the cost that the CTX
  // channel exists to avoid.
  const cost = [3, 5, 9].map((t) => render(t).length)
  assert.ok(Math.max(...cost) - Math.min(...cost) < 120, `sizes drifted: ${cost.join(' -> ')}`)
  const rows = new Set([1, 3, 5, 9].map((t) => gridRows(render(t)).length))
  assert.strictEqual(rows.size, 1, 'every thickness must render the same grid shape')
})

test('thick=1 is the original single-plane slice', () => {
  const thin = render(1)
  assert.ok(!thin.includes('PROJECTED'), 'no advisory when nothing was projected')
  assert.ok(!/thick=/.test(thin.split('\n')[0]), 'no thick= in the header')
  assert.deepStrictEqual(render(1), PROVIDERS.slice.render(['ew', '8']),
    'omitting the arg must equal passing 1')
})

test('thickness is clamped and rounds up, never down', () => {
  // Rounding up means a request never silently yields fewer planes than asked for.
  assert.match(render(4).split('\n')[0], /thick=5/)
  assert.match(render(2).split('\n')[0], /thick=3/)
  assert.match(render(99).split('\n')[0], /thick=9/)
  assert.ok(!/thick=/.test(render(0).split('\n')[0]), 'thick=0 collapses to a single plane')
})

test('the projected view warns that "." is not a guaranteed corridor', () => {
  // A "." in a slab means some plane there is air, which is not the same as a walkable
  // 1-wide tunnel. Without this the model reads a projected slice as a nav plan.
  const t5 = render(5)
  assert.match(t5, /PROJECTED over 5 planes \(z=-2\.\.2\)/)
  assert.match(t5, /NOT a guaranteed 1-wide corridor/)
})

test('the ns axis projects across x instead of z', () => {
  const ns = PROVIDERS.slice.render(['ns', '8', '5'])
  assert.match(ns, /PROJECTED over 5 planes \(x=-2\.\.2\)/)
})
