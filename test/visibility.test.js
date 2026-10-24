// Unit tests for the visibility system. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const state = require('../src/core/state')
const mcData = require('minecraft-data')('26.1')
const { viewVector, inFov, blockVisible, surveyVisible, formatSurvey } = require('../src/perception/visibility')

const MIN_Y = -64, NUM_SECTIONS = 24
const sid = (name) => name === 'air' ? 0 : (mcData.blocksByName[name]?.minStateId ?? 0)

// Build a palette-backed getColumns() from worldMap, so surveyVisible's chunk-scan
// discovery (chunkScan.scanCandidates) sees the same blocks the LOS mock does.
function buildColumns(worldMap) {
  const cols = new Map() // "cx,cz" -> sections[]
  for (const [key, name] of worldMap) {
    const [x, y, z] = key.split(',').map(Number)
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16), ck = cx + ',' + cz
    if (!cols.has(ck)) cols.set(ck, new Array(NUM_SECTIONS).fill(null))
    const sections = cols.get(ck)
    const rel = y - MIN_Y, s = rel >> 4, ly = rel & 15
    if (!sections[s]) {
      const backing = new Map(), pal = new Set([0])
      sections[s] = { data: { _b: backing, _pal: pal, palette: null, get(i) { return backing.get(i) || 0 } } }
    }
    const sec = sections[s]
    const llx = ((x % 16) + 16) % 16, llz = ((z % 16) + 16) % 16
    sec.data._b.set((ly << 8) | (llz << 4) | llx, sid(name))
    sec.data._pal.add(sid(name))
  }
  const out = []
  for (const [ck, sections] of cols) {
    for (const sec of sections) if (sec) sec.data.palette = [...sec.data._pal]
    const [cx, cz] = ck.split(',').map(Number)
    out.push({ chunkX: String(cx), chunkZ: String(cz), column: { minY: MIN_Y, sections } })
  }
  return out
}

// --- Mock world -----------------------------------------------------------
// worldMap: "x,y,z" -> block name. Everything absent is air.
// light: (x, y, z) → block light of the cell; given, the bot is in the overworld (the
// light gate is on), otherwise in no dimension at all (no gate).
function makeBot(worldMap, { pos = new Vec3(0.5, 0.5, 0.5), yaw = 0, pitch = 0, entities = {}, light = null } = {}) {
  const blockAt = (v) => ({ name: worldMap.get(`${v.x},${v.y},${v.z}`) || 'air', position: v })
  const columns = buildColumns(worldMap)
  // getColumn serves the LOS rays (fastworld); a column with no blocks is all air.
  const getColumn = (cx, cz) => {
    const c = columns.find(c => c.chunkX === String(cx) && c.chunkZ === String(cz))
    const col = { minY: MIN_Y, sections: c ? c.column.sections : new Array(NUM_SECTIONS).fill(null) }
    if (light) {
      col.blockLightSections = Array.from({ length: NUM_SECTIONS + 2 }, (_, s) => ({
        get: (i) => light(cx * 16 + (i & 15), MIN_Y + (s - 1) * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15)),
      }))
      // Sent, and dark: a section the server didn't send would read as open sky (#209).
      col.skyLightSections = Array.from({ length: NUM_SECTIONS + 2 }, () => ({ get: () => 0 }))
    }
    return col
  }
  const bot = {
    version: '26.1',
    entity: { position: pos, yaw, pitch },
    entities,
    blockAt,
    world: { getColumns: () => columns, getColumn },
  }
  if (light) Object.assign(bot, { game: { dimension: 'minecraft:overworld', minY: MIN_Y }, time: { timeOfDay: 6000 }, registry: mcData })
  return bot
}

function w(entries) {
  const m = new Map()
  for (const [k, v] of entries) m.set(k, v)
  return m
}

// --- viewVector -----------------------------------------------------------
test('viewVector: yaw 0 faces north (-z)', () => {
  state.bot = makeBot(w([]), { yaw: 0, pitch: 0 })
  const d = viewVector(state.bot)
  assert.ok(Math.abs(d.x - 0) < 1e-9)
  assert.ok(Math.abs(d.y - 0) < 1e-9)
  assert.ok(Math.abs(d.z - -1) < 1e-9)
})

test('viewVector: yaw PI/2 faces west (-x)', () => {
  state.bot = makeBot(w([]), { yaw: Math.PI / 2, pitch: 0 })
  const d = viewVector(state.bot)
  assert.ok(Math.abs(d.x - -1) < 1e-9, `x=${d.x}`)
  assert.ok(Math.abs(d.z - 0) < 1e-9, `z=${d.z}`)
})

test('viewVector: positive pitch looks up (+y)', () => {
  state.bot = makeBot(w([]), { yaw: 0, pitch: Math.PI / 4 })
  const d = viewVector(state.bot)
  assert.ok(d.y > 0.5, `y=${d.y}`)
})

// --- inFov ----------------------------------------------------------------
test('inFov: point ahead inside cone, behind outside', () => {
  const eye = new Vec3(0, 0, 0)
  const look = new Vec3(0, 0, -1)
  const cosHalf = Math.cos(60 * Math.PI / 180) // 120° full FOV
  assert.equal(inFov(eye, look, { x: 0, y: 0, z: -5 }, cosHalf), true)
  assert.equal(inFov(eye, look, { x: 0, y: 0, z: 5 }, cosHalf), false)
  assert.equal(inFov(eye, look, { x: 5, y: 0, z: 0 }, cosHalf), false) // 90° off → outside 60° half
})

test('inFov: omni (cosHalf<=-1) accepts everything', () => {
  const eye = new Vec3(0, 0, 0), look = new Vec3(0, 0, -1)
  assert.equal(inFov(eye, look, { x: 0, y: 0, z: 5 }, -1), true)
})

// --- blockVisible ---------------------------------------------------------
test('blockVisible: clear air → visible', () => {
  state.bot = makeBot(w([]))
  const eye = new Vec3(0.5, 0.5, 0.5)
  assert.equal(blockVisible(eye, 0, 0, -5), true)
})

test('blockVisible: solid wall in the way → not visible', () => {
  state.bot = makeBot(w([['0,0,-2', 'stone']]))
  const eye = new Vec3(0.5, 0.5, 0.5)
  assert.equal(blockVisible(eye, 0, 0, -5), false)
})

test('blockVisible: transparent glass in the way → still visible', () => {
  state.bot = makeBot(w([['0,0,-2', 'glass']]))
  const eye = new Vec3(0.5, 0.5, 0.5)
  assert.equal(blockVisible(eye, 0, 0, -5), true)
})

test('blockVisible: adjacent block always visible', () => {
  state.bot = makeBot(w([['0,0,-1', 'stone']]))
  const eye = new Vec3(0.5, 0.5, 0.5)
  assert.equal(blockVisible(eye, 0, 0, -1), true)
})

test('blockVisible: visible around a partial wall via a clear face', () => {
  // Wall blocks the -z face line but the block is offset so an eye-facing side is open.
  state.bot = makeBot(w([['0,0,-2', 'stone']]))
  const eye = new Vec3(0.5, 0.5, 0.5)
  // A block beside the wall: eye sees its +z face (toward eye) with a clear ray.
  assert.equal(blockVisible(eye, 2, 0, -2), true)
})

// --- surveyVisible + formatSurvey ----------------------------------------
test('surveyVisible: reports visible block, hides occluded one', () => {
  // Eye is at y≈2.12, so a 1-tall wall is seen over via the block's top face — the
  // occluder must cover the eye-facing sightlines, hence a 3-tall wall.
  const world = w([
    ['0,0,-2', 'stone'],                                  // visible (in front of wall)
    ['0,0,-3', 'stone'], ['0,1,-3', 'stone'], ['0,2,-3', 'stone'], // 3-tall wall
    ['0,0,-8', 'iron_ore'],                               // hidden behind the wall
  ])
  state.bot = makeBot(world, { yaw: 0, pitch: 0 }) // looking north
  const s = surveyVisible({ maxDistance: 40, fovDegrees: 160 })
  assert.ok(s.blocks.stone, 'stone should be visible')
  assert.ok(!s.blocks.iron_ore, 'iron_ore behind wall must NOT be reported')
})

test('surveyVisible: sees ore through glass (transparent gate)', () => {
  const world = w([
    ['0,0,-2', 'glass'],
    ['0,0,-4', 'diamond_ore'],
  ])
  state.bot = makeBot(world, { yaw: 0, pitch: 0 })
  const s = surveyVisible({ maxDistance: 40, fovDegrees: 160 })
  assert.ok(s.blocks.diamond_ore, 'diamond_ore behind glass should be visible')
})

test('surveyVisible: FOV culls blocks behind the bot', () => {
  const world = w([
    ['0,0,-5', 'stone'],  // ahead (north)
    ['0,0,5', 'gold_ore'], // behind (south)
  ])
  state.bot = makeBot(world, { yaw: 0, pitch: 0 })
  const s = surveyVisible({ maxDistance: 40, fovDegrees: 120 })
  assert.ok(s.blocks.stone, 'block ahead visible')
  assert.ok(!s.blocks.gold_ore, 'block behind should be FOV-culled')
  // omni mode should now include it
  const s2 = surveyVisible({ maxDistance: 40, omni: true })
  assert.ok(s2.blocks.gold_ore, 'omni mode includes block behind')
})

test('surveyVisible: in the dark overworld an ore is not seen, a torch-lit one is', () => {
  const world = w([['0,0,-4', 'coal_ore']])
  state.bot = makeBot(world, { light: () => 0 })
  assert.ok(!surveyVisible({ maxDistance: 40, omni: true }).blocks.coal_ore, 'dark ore must not be seen')
  // Lit only in the cell in front of its south face (toward the bot); the air between is dark.
  state.bot = makeBot(world, { light: (x, y, z) => x === 0 && y === 0 && z === -3 ? 12 : 0 })
  assert.ok(surveyVisible({ maxDistance: 40, omni: true }).blocks.coal_ore, 'lit face seen through dark air')
  // Lit only behind it: the face the bot sees stays dark.
  state.bot = makeBot(world, { light: (x, y, z) => x === 0 && y === 0 && z === -5 ? 12 : 0 })
  assert.ok(!surveyVisible({ maxDistance: 40, omni: true }).blocks.coal_ore, 'far side lit only')
})

test('surveyVisible: a light source shows in the dark', () => {
  state.bot = makeBot(w([['0,0,-4', 'glowstone']]), { light: () => 0 })
  assert.ok(surveyVisible({ maxDistance: 40, omni: true }).blocks.glowstone)
})

test('formatSurvey: hazards/resources sort first and string is well-formed', () => {
  const world = w([
    ['0,0,-3', 'stone'],
    ['1,0,-3', 'stone'],
    ['0,0,-4', 'lava'],
    ['0,0,-5', 'iron_ore'],
  ])
  state.bot = makeBot(world, { yaw: 0, pitch: 0 })
  const s = surveyVisible({ maxDistance: 40, fovDegrees: 160 })
  const str = formatSurvey(s)
  assert.match(str, /^ VIEW=\[/)
  const seeIdx = str.indexOf('lava')
  const oreIdx = str.indexOf('iron_ore')
  const stoneIdx = str.indexOf('stone')
  assert.ok(seeIdx >= 0 && oreIdx >= 0 && stoneIdx >= 0)
  assert.ok(seeIdx < oreIdx, 'hazard before resource')
  assert.ok(oreIdx < stoneIdx, 'resource before plain block')
})
