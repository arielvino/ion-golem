#!/usr/bin/env node
// sample-visible.js — what can the bot SEE around here, sorted? Field data for "base materials".
//
// Connects a bare mineflayer probe (no engine, no AI) to the local dev server and, for each
// target, puts it on the surface or in a cave pocket, snapshots the cube of radius R around the
// eye from the chunk section palettes, and casts one ray from the eye to the centre of every
// block on the cube's shell (≈ one ray per block at distance R). A ray counts every block it
// passes (air/water/leaves/... included) and stops at the first opaque one. Each block counts
// once. Prints the sorted list, with air as its own line, plus timing and openness.
//
// Usage: node tools/sample-visible.js [target ...]      (default: TARGETS below)
//   target = [nether/|end/]biome:<id>[@where] | [nether/|end/]at:<x>,<z>[@where]
//   where  = surface (default in the overworld/end) | <Y> (nearest cave pocket around that Y)
//          | cave (nearest pocket around the Y `locate` returned; default in the nether)
// Needs the local server started by minecraft-launch (server/server.stdin + server.log).
const path = require('path')
const fs = require('fs')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { performance } = require('perf_hooks')
const { recognizeView, formatPlacesContext } = require('../src/perception/recognize')
const { snapshot, castRays, seenBlocks, opaqueTable, AIR } = require('../src/perception/sight')
const state = require('../src/core/state')
const { summarizeSight, formatSight } = require('../src/perception/sightSummary')

const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '26.1'
const NAME = process.env.PROBE_NAME || 'SeeProbe'
const R = parseInt(process.env.RADIUS || '64', 10)
const OUT_DIR = process.env.DUMP_OUT || '/tmp/visible-samples'
const SERVER_DIR = path.join(__dirname, '..', '..', 'server')
const STDIN = path.join(SERVER_DIR, 'server.stdin')
const LOG = path.join(SERVER_DIR, 'server.log')

const TARGETS = [
  'biome:plains', 'biome:forest', 'biome:desert', 'biome:snowy_plains', 'biome:swamp',
  'biome:ocean', 'biome:badlands', 'biome:jungle', 'biome:jagged_peaks', 'biome:cherry_grove',
  'biome:plains@30', 'biome:plains@0', 'biome:plains@-30', 'biome:plains@-55', 'biome:lush_caves@cave', 'biome:dripstone_caves@cave', 'biome:deep_dark@cave',
  'nether/biome:nether_wastes', 'nether/biome:crimson_forest', 'nether/biome:warped_forest',
  'nether/biome:soul_sand_valley', 'nether/biome:basalt_deltas',
  'end/at:40,20', 'end/biome:end_highlands',
]
const DIMS = { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const now = () => performance.now()
const consoleCmd = (cmd) => fs.appendFileSync(STDIN, cmd + '\n')

// Send a console command and wait for a server.log line matching `re` written after it.
async function consoleAwait(cmd, re, timeoutMs = 60000) {
  const start = fs.statSync(LOG).size
  consoleCmd(cmd)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500)
    const size = fs.statSync(LOG).size
    if (size <= start) continue
    const fd = fs.openSync(LOG, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const m = buf.toString().match(re)
    if (m) return m
  }
  return null
}

// Wait until the loaded chunk count stops changing.
async function settle(bot, maxMs = 60000) {
  const t0 = Date.now()
  let last = -1, stable = 0
  while (Date.now() - t0 < maxMs && stable < 3) {
    await sleep(1000)
    const n = bot.world.getColumns().length
    stable = n === last ? stable + 1 : 0
    last = n
  }
}

const yRange = (bot) => { const minY = bot.game.minY ?? -64; return [minY, minY + (bot.game.height ?? 384) - 1] }
const solid = (b) => b && b.boundingBox === 'block'

const inBiome = (bot, p, biome) => !biome || bot.registry.biomes[bot.world.getBiome(p)]?.name === biome

// Where to stand on the surface near x,z: the ground under any tree canopy, on the nearest column
// within 32 that is dry land (liquid top only if `wet`, e.g. an ocean). Returns feet or null.
const CANOPY = /_leaves$|_log$|_wood$|mushroom_block$|^mushroom_stem$/
function groundY(bot, x, z) {   // { y: feet y, wet }
  const [minY, maxY] = yRange(bot)
  for (let y = maxY; y >= minY; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return null
    if (b.name === 'water' || b.name === 'lava') return { y: y + 1, wet: true }
    if (solid(b) && !CANOPY.test(b.name)) return { y: y + 1, wet: false }
  }
  return null
}
function surfaceSpot(bot, x, z, wet, biome) {
  for (let r = 0; r <= 32; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
    const g = groundY(bot, x + dx, z + dz)
    if (g && (wet || !g.wet) && inBiome(bot, new Vec3(x + dx, g.y, z + dz), biome)) return new Vec3(x + dx, g.y, z + dz)
  }
  return null
}

// Nearest 2-high air pocket with a solid floor around (x,y,z): feet position, or null.
function pocketNear(bot, x, y, z, biome, rh = 48, rv = 24) {
  const isAir = (p) => { const b = bot.blockAt(p); return b && AIR.has(b.name) }
  let best = null, bestD = Infinity
  for (let dy = 0; dy <= rv; dy = dy > 0 ? -dy : 1 - dy) {   // 0, 1, -1, 2, -2, ...
    for (let dx = -rh; dx <= rh; dx += 2) for (let dz = -rh; dz <= rh; dz += 2) {
      const d = dx * dx + dz * dz + 4 * dy * dy
      if (d >= bestD) continue
      const p = new Vec3(x + dx, y + dy, z + dz)
      if (isAir(p) && isAir(p.offset(0, 1, 0)) && solid(bot.blockAt(p.offset(0, -1, 0))) && inBiome(bot, p, biome)) { best = p; bestD = d }
    }
    if (best && dy * dy * 4 > bestD) break
  }
  return best
}

async function goTo(bot, spec) {
  const [dimPart, rest] = spec.includes('/') ? spec.split('/') : ['overworld', spec]
  const dim = DIMS[dimPart]
  const [target, whereArg] = rest.split('@')
  const where = whereArg ?? (dimPart === 'nether' ? 'cave' : 'surface')
  const [kind, id] = target.split(':')
  let x, y = null, z
  if (kind === 'at') {
    [x, z] = id.split(',').map(Number)
  } else {
    const found = await consoleAwait(`execute in ${dim} run locate biome minecraft:${id}`,
      new RegExp(`nearest minecraft:${id} is at \\[(-?\\d+), (~|-?\\d+), (-?\\d+)\\]|Could not find a biome of type "?minecraft:${id}`), 90000)
    if (!found || found[1] === undefined) return { error: found ? 'none nearby' : 'locate timed out' }
    x = Number(found[1]); z = Number(found[3]); if (found[2] !== '~') y = Number(found[2])
  }
  // Hover first so the column loads (switching dimension if needed), then pick the spot.
  const hoverY = dimPart === 'nether' ? 64 : 200
  const switched = bot.game.dimension === dim.replace('minecraft:', '') ? null
    : new Promise(res => { bot.once('respawn', res); setTimeout(res, 15000) })
  consoleCmd(`execute in ${dim} run tp ${NAME} ${x} ${hoverY} ${z}`)
  if (switched) { await switched; console.log(`  [dim] now ${bot.game.dimension}, ${bot.world.getColumns().length} columns`) }
  await sleep(1500)
  await settle(bot)
  let feet
  if (where === 'surface') {
    const biome = kind === 'biome' ? id : null
    feet = surfaceSpot(bot, x, z, /ocean|river|swamp/.test(id), biome); if (!feet) return { error: 'no dry ground near the target' }
  } else {
    const cy = where === 'cave' ? (y ?? 64) : Number(where)
    feet = pocketNear(bot, x, cy, z, kind === 'biome' && where === 'cave' ? id : null); if (!feet) return { error: `no air pocket near y=${cy}` }
  }
  consoleCmd(`execute in ${dim} run tp ${NAME} ${feet.x + 0.5} ${feet.y} ${feet.z + 0.5}`)
  await sleep(2000)
  await settle(bot)
  return { feet }
}

// Map(stateId -> count) -> [[name, count]] without air, sorted.
function named(byId, nameOf) {
  const byName = new Map()
  for (const [id, c] of byId) { const n = nameOf(id); if (!AIR.has(n)) byName.set(n, (byName.get(n) || 0) + c) }
  return [...byName].sort((a, b) => b[1] - a[1])
}

function table(rows, total, limit) {
  return rows.slice(0, limit).map(([n, c]) => `  ${n.padEnd(26)} ${String(c).padStart(7)}  ${(100 * c / total).toFixed(1).padStart(5)}%`).join('\n')
}

async function main() {
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: VERSION })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); setTimeout(() => rej(new Error('spawn timeout')), 60000) })
  bot.physicsEnabled = false                 // else the client applies gravity and the probe sinks from where it was put
  consoleCmd(`gamemode spectator ${NAME}`)   // no drowning or burning while it looks
  await sleep(2000)
  const opaque = opaqueTable(bot.registry)
  state.bot = bot                            // recognizeView reads the bot from state
  const allBiomes = new Map()   // biome -> { samples, counts: Map(name -> n) }
  const nameOf = (s) => bot.registry.blocksByStateId[s]?.name || `state#${s}`
  for (const spec of specs) {
    console.log(`\n=== ${spec} ===`)
    const go = await goTo(bot, spec)
    if (go.error) { console.log(`  ${go.error}`); continue }
    const eye = bot.entity.position.offset(0, 1.62, 0)
    let t = now(); const d = snapshot(bot, eye, R); const tSnap = now() - t
    t = now(); const { seen, rays, open } = castRays(d, opaque, R); const tCast = now() - t
    t = now()
    const byId = new Uint32Array(1 << 16)
    for (let i = 0; i < seen.length; i++) if (seen[i]) byId[d.snap[i]]++
    const byName = new Map()
    for (let id = 0; id < byId.length; id++) if (byId[id]) { const n = nameOf(id); byName.set(n, (byName.get(n) || 0) + byId[id]) }
    const all = [...byName].sort((a, b) => b[1] - a[1]); const tSort = now() - t
    const airN = all.filter(([n]) => AIR.has(n)).reduce((s, [, c]) => s + c, 0)
    const blocks = all.filter(([n]) => !AIR.has(n)), blockN = blocks.reduce((s, [, c]) => s + c, 0)
    const p = bot.entity.position.floored()
    const out = { spec, at: { x: p.x, y: p.y, z: p.z }, dimension: bot.game.dimension, biome: bot.registry.biomes[bot.world.getBiome(p)]?.name,
      radius: R, rays, openRays: open, ms: { snapshot: +tSnap.toFixed(1), rays: +tCast.toFixed(1), sort: +tSort.toFixed(2) },
      air: airN, blocks: blockN, counts: blocks }
    t = now()
    const vis = seenBlocks(bot, d, seen)
    const bb = new Map()
    for (const b of vis) { let m = bb.get(b.biome); if (!m) bb.set(b.biome, m = new Map()); m.set(b.id, (m.get(b.id) || 0) + 1) }
    const tBiome = now() - t
    t = now()
    const rec = recognizeView({ eye, blocks: vis }, { maxDistance: R })
    const tRec = now() - t
    t = now()
    const sight = summarizeSight({ dimension: bot.game.dimension, eye, blocks: vis, places: rec.places })
    const tSum = now() - t
    out.ms.biome = +tBiome.toFixed(1); out.ms.recognize = +tRec.toFixed(1); out.ms.summary = +tSum.toFixed(1)
    out.sight = sight
    out.places = rec.places.map(p => ({ ...p, counts: Object.fromEntries(p.counts) }))
    out.byBiome = Object.fromEntries([...bb].map(([b, m]) => [b, named(m, nameOf)]))
    for (const [b, rows] of Object.entries(out.byBiome)) {
      const agg = allBiomes.get(b) || { samples: [], counts: new Map() }; allBiomes.set(b, agg)
      if (rows.length) agg.samples.push(spec)
      for (const [n, c] of rows) agg.counts.set(n, (agg.counts.get(n) || 0) + c)
    }
    fs.writeFileSync(path.join(OUT_DIR, `${spec.replace(/[:@,/]/g, '_')}.json`), JSON.stringify(out, null, 1))
    console.log(`  @${p.x},${p.y},${p.z} ${bot.game.dimension} (biome here: ${out.biome})  snapshot ${tSnap.toFixed(0)} ms, rays ${tCast.toFixed(0)} ms, sort ${tSort.toFixed(2)} ms`)
    console.log(`  rays reaching ${R} unblocked: ${(100 * open / rays).toFixed(0)}%   air passed: ${airN}   blocks seen: ${blockN} (${blocks.length} kinds)`)
    console.log(table(blocks, blockN, 15))
    console.log(`  biome lookup ${tBiome.toFixed(0)} ms, recognize ${tRec.toFixed(0)} ms, summary ${tSum.toFixed(0)} ms`)
    console.log('  --- what the model would get:')
    console.log((formatSight(sight) + '\n' + (formatPlacesContext(rec).trim() || 'PLACES=[]')).split('\n').map(l => '  ' + l).join('\n'))
  }
  // Every sample merged, grouped by the biome each seen block is in, then sorted.
  console.log('\n##### BY BIOME (all samples merged) #####')
  const merged = {}
  for (const [b, { samples, counts }] of [...allBiomes].sort()) {
    const rows = [...counts].sort((a, b) => b[1] - a[1]), n = rows.reduce((s, [, c]) => s + c, 0)
    if (!n) continue
    merged[b] = { blocks: n, samples, counts: rows }
    console.log(`\n=== ${b}: ${n} blocks from ${samples.length} sample(s): ${samples.join(', ')}`)
    console.log(table(rows, n, 15))
  }
  fs.writeFileSync(path.join(OUT_DIR, 'by-biome.json'), JSON.stringify(merged, null, 1))
  bot.quit()
  setTimeout(() => process.exit(0), 500)
}

main().catch(e => { console.error(e); process.exit(1) })
