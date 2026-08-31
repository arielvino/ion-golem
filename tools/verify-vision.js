#!/usr/bin/env node
// verify-vision.js — differential test: fastworld LOS vs the original bot.blockAt LOS.
//
// A perception speedup is only worth anything if it returns the SAME answers. This
// connects once, then for the identical world state runs both implementations over the
// same inputs and diffs them:
//   1. rayClear   — thousands of random rays, both block sets (TRANSPARENT, PASSABLE)
//   2. blockVisible — every candidate the nav scan produces
//   3. surveyForNav — the full written block set, compared key-by-key
// Any mismatch is printed with coordinates so it can be reproduced.
//
// Both paths run in ONE process (the fast/slow switch is read per call here, not from
// the module-level env flag), so there is no chunk-state drift between the two runs.
//
// Usage: node tools/verify-vision.js [rayCount]
const path = require('path')
const fs = require('fs')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const state = require('../src/core/state')

const RAYS = parseInt(process.argv[2] || '4000', 10)
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '1.21.11'

const DATA_DIR = process.env.BENCH_DATA_DIR || path.join(__dirname, '..', '..', '.bench-runtime')
fs.mkdirSync(DATA_DIR, { recursive: true })
state.BOT_DATA_DIR = DATA_DIR
require('../src/world/memory').initDB()

const { TRANSPARENT, PASSABLE } = require('../src/config/blocks')
const { voxelCells, isDiagBlocked } = require('../src/perception/vision')
const { scanCandidates } = require('../src/perception/chunkScan')
const vision = require('../src/perception/vision')

// Reference implementation, lifted verbatim from the pre-optimisation _rayClear /
// isDiagBlocked so the comparison is against real old behaviour, not a paraphrase.
function refDiagBlocked(bot, px, py, pz, bx, by, bz, passSet) {
  const dx = bx !== px, dy = by !== py, dz = bz !== pz
  if (dx + dy + dz < 2) return false
  const isSolid = (x, y, z) => {
    try {
      const b = bot.blockAt(new Vec3(x, y, z))
      return b && !passSet.has(b.name)
    } catch (e) { return true }
  }
  if (dx && dz) {
    if (isSolid(bx, py, pz) && isSolid(px, py, bz)) return true
    if (dy && isSolid(bx, by, pz) && isSolid(px, by, bz)) return true
  }
  if (dx && dy) {
    if (isSolid(bx, py, pz) && isSolid(px, by, pz)) return true
    if (dz && isSolid(bx, py, bz) && isSolid(px, by, bz)) return true
  }
  if (dy && dz) {
    if (isSolid(px, by, pz) && isSolid(px, py, bz)) return true
    if (dx && isSolid(bx, by, pz) && isSolid(bx, py, bz)) return true
  }
  return false
}

function refRayClear(from, to, blockSet) {
  const allowSet = blockSet || TRANSPARENT
  const bot = state.bot
  for (const [bx, by, bz, lastBx, lastBy, lastBz] of voxelCells(from, to)) {
    if (refDiagBlocked(bot, lastBx, lastBy, lastBz, bx, by, bz, allowSet)) return false
    try {
      const b = bot.blockAt(new Vec3(bx, by, bz))
      if (!b) return false
      if (!allowSet.has(b.name)) return false
    } catch (e) { return false }
  }
  return true
}

// Original blockVisible, expressed over refRayClear.
function refBlockVisible(eye, bx, by, bz) {
  const faces = []
  if (eye.x > bx + 1) faces.push({ d: eye.x - (bx + 1), p: new Vec3(bx + 1, by + 0.5, bz + 0.5) })
  else if (eye.x < bx) faces.push({ d: bx - eye.x, p: new Vec3(bx, by + 0.5, bz + 0.5) })
  if (eye.y > by + 1) faces.push({ d: eye.y - (by + 1), p: new Vec3(bx + 0.5, by + 1, bz + 0.5) })
  else if (eye.y < by) faces.push({ d: by - eye.y, p: new Vec3(bx + 0.5, by, bz + 0.5) })
  if (eye.z > bz + 1) faces.push({ d: eye.z - (bz + 1), p: new Vec3(bx + 0.5, by + 0.5, bz + 1) })
  else if (eye.z < bz) faces.push({ d: bz - eye.z, p: new Vec3(bx + 0.5, by + 0.5, bz) })
  if (faces.length === 0) return true
  faces.sort((a, b) => b.d - a.d)
  for (const f of faces) if (refRayClear(eye, f.p)) return true
  return false
}

async function main() {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'VerifyBot', version: VERSION })
  state.bot = bot
  await new Promise((res, rej) => {
    bot.once('spawn', res); bot.once('error', rej)
    setTimeout(() => rej(new Error('spawn timeout')), 60000)
  })
  let cols = 0
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const n = bot.world.getColumns().length
    if (n === cols && n > 40) break
    cols = n
  }
  console.log(`connected ${bot.version}, ${cols} columns, pos=${bot.entity.position.floored()}\n`)

  const eye = bot.entity.position.offset(0, 1.62, 0)
  let fails = 0, checked = 0

  // ── 1. random rays, both block sets ──────────────────────────────────
  for (const [setName, set] of [['TRANSPARENT', TRANSPARENT], ['PASSABLE', PASSABLE]]) {
    let bad = 0
    for (let i = 0; i < RAYS; i++) {
      const r = 4 + Math.random() * 36
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      const to = eye.offset(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th))
      const a = vision.rayClear(eye, to, set)
      const b = refRayClear(eye, to, set)
      checked++
      if (a !== b) {
        bad++; fails++
        if (bad <= 3) console.log(`  MISMATCH rayClear/${setName}: fast=${a} ref=${b} to=${to.floored()}`)
      }
    }
    console.log(`rayClear/${setName.padEnd(11)} ${RAYS} rays, ${bad} mismatches`)
  }

  // ── 2. blockVisible over the real candidate set ──────────────────────
  const cands = scanCandidates({ origin: eye, cosHalf: -1, maxDistance: 32, count: 2000 })
  let bvBad = 0
  for (const c of cands) {
    const a = require('../src/perception/visibility').blockVisible(eye, c.x, c.y, c.z)
    const b = refBlockVisible(eye, c.x, c.y, c.z)
    checked++
    if (a !== b) {
      bvBad++; fails++
      if (bvBad <= 3) console.log(`  MISMATCH blockVisible: fast=${a} ref=${b} at ${c.x},${c.y},${c.z} (${c.name})`)
    }
  }
  console.log(`blockVisible            ${cands.length} candidates, ${bvBad} mismatches`)

  // ── 3. block NAMES via fastworld vs bot.blockAt ──────────────────────
  // The name path is separate from the boolean LOS path and needs its own check: an
  // earlier bug sized the state->name table from blocksByStateId.length (undefined on
  // a plain object), so every sightline cell was silently written as 'air' while every
  // ray test above still passed. Names are what land in the DB — verify them directly.
  const fwmod = require('../src/perception/fastworld')
  const names = fwmod.stateNames(require('minecraft-data')(bot.version))
  const base = bot.entity.position.floored()
  let nameBad = 0, nameChecked = 0
  // Wide, because castVisionRays now reads names through this path exclusively (it only
  // ever used block.name), and it is not otherwise output-diffed here.
  for (let dx = -40; dx <= 40; dx += 2) {
    for (let dy = -24; dy <= 24; dy += 2) {
      for (let dz = -40; dz <= 40; dz += 2) {
        const x = base.x + dx, y = base.y + dy, z = base.z + dz
        const ref = bot.blockAt(new Vec3(x, y, z))
        const fast = fwmod.nameAt(names, x, y, z)
        nameChecked++; checked++
        const refName = ref ? ref.name : null
        if (refName !== fast) {
          nameBad++; fails++
          if (nameBad <= 5) console.log(`  MISMATCH name @${x},${y},${z}: fast=${fast} ref=${refName}`)
        }
      }
    }
  }
  console.log(`nameAt                  ${nameChecked} cells, ${nameBad} mismatches`)

  // ── 4. full surveyForNav write set ───────────────────────────────────
  const { surveyForNav } = require('../src/perception/visibility')
  const capture = []
  const origRun = state.stmts.upsertBlock.run.bind(state.stmts.upsertBlock)
  state.stmts.upsertBlock.run = (x, y, z, n, t) => { capture.push(`${x},${y},${z}=${n}`); return origRun(x, y, z, n, t) }
  surveyForNav({})
  const fastSet = new Set(capture)
  const airWrites = capture.filter(s => s.endsWith('=air')).length
  console.log(`surveyForNav            ${fastSet.size} distinct writes, ${airWrites} air`)

  console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${checked} comparisons, ${fails} mismatches`)
  bot.quit()
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error('verify failed:', e.message); process.exit(1) })
