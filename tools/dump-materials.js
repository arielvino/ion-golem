#!/usr/bin/env node
// dump-materials.js — what is the world around here made of? Field data for "base materials".
//
// Connects a bare mineflayer probe (no engine, no AI) to the local dev server. For each
// target — a biome (`locate biome`), a structure (`locate structure`) or plain coordinates —
// it puts the probe there (creative, standing on the ground or at a given Y), waits until
// the server has sent every chunk in view distance, and counts every non-air block in ALL
// the chunks the probe has loaded (bedrock to sky), most abundant first. Writes one JSON
// per target to OUT_DIR and prints the sorted table.
//
// Usage: node tools/dump-materials.js [target ...]
//   target = biome:<id>[@Y] | structure:<id>[@Y] | at:<x>,<z>[@Y]   (default: TARGETS below)
//   Y      = a block Y to stand at; omitted = on the surface
// Needs the local server started by minecraft-launch (server/server.stdin + server.log).
const path = require('path')
const fs = require('fs')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '26.1'
const NAME = process.env.PROBE_NAME || 'MatProbe'
const OUT_DIR = process.env.DUMP_OUT || '/tmp/material-dumps'
const SERVER_DIR = path.join(__dirname, '..', '..', 'server')
const STDIN = path.join(SERVER_DIR, 'server.stdin')
const LOG = path.join(SERVER_DIR, 'server.log')

const TARGETS = [
  'biome:plains', 'biome:forest', 'biome:desert', 'biome:snowy_plains', 'biome:taiga',
  'biome:swamp', 'biome:ocean', 'biome:badlands', 'biome:jungle', 'biome:jagged_peaks',
  'structure:village_plains',
]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
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

const AIR = new Set(['air', 'cave_air', 'void_air'])
const yRange = (bot) => { const minY = bot.game.minY ?? -64; return [minY, minY + (bot.game.height ?? 384) - 1] }

// Loaded chunks: how many, and how many of the view-distance square around the probe are still missing.
function loadState(bot, viewDistance) {
  const p = bot.entity.position
  const pcx = Math.floor(p.x / 16), pcz = Math.floor(p.z / 16)
  let missing = 0
  for (let cx = pcx - viewDistance; cx <= pcx + viewDistance; cx++)
    for (let cz = pcz - viewDistance; cz <= pcz + viewDistance; cz++)
      if (!bot.world.getColumn(cx, cz)) missing++
  return { loaded: bot.world.getColumns().length, missing }
}

// Count blocks in every chunk the probe has loaded. Returns { counts, chunks, columns }.
function countLoaded(bot) {
  const names = (id) => bot.registry.blocksByStateId[id]?.name || `state#${id}`
  const [minY, maxY] = yRange(bot)
  const counts = new Map()
  let chunks = 0, columns = 0
  const v = new Vec3(0, 0, 0)
  for (const { column: col } of bot.world.getColumns()) {
    chunks++
    for (let lx = 0; lx < 16; lx++) {
      for (let lz = 0; lz < 16; lz++) {
        columns++
        for (let y = maxY; y >= minY; y--) {
          v.set(lx, y, lz)
          const n = names(col.getBlockStateId(v))
          if (!AIR.has(n)) counts.set(n, (counts.get(n) || 0) + 1)
        }
      }
    }
  }
  return { counts, chunks, columns }
}

// Highest block at x,z the probe could stand on (solid or liquid top), from the loaded chunk.
function surfaceY(bot, x, z) {
  const [minY, maxY] = yRange(bot)
  for (let y = maxY; y >= minY; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b && (b.boundingBox === 'block' || b.name === 'water' || b.name === 'lava')) return y + 1
  }
  return null
}

// Wait until the loaded chunk count stops changing (the server has sent the view-distance circle).
async function settle(bot, viewDistance, maxMs = 60000) {
  const t0 = Date.now()
  let last = -1, stable = 0, s
  while (Date.now() - t0 < maxMs) {
    await sleep(1000)
    s = loadState(bot, viewDistance)
    stable = s.loaded === last ? stable + 1 : 0   // the server sends a circle, so some corners of the square never come
    last = s.loaded
    if (stable >= 3) break
  }
  return s
}

const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])
function table(m, limit) {
  const rows = sorted(m)
  const total = rows.reduce((s, [, c]) => s + c, 0)
  return rows.slice(0, limit).map(([n, c]) => `${(100 * c / total).toFixed(c / total < 0.001 ? 4 : 2).padStart(8)}%  ${String(c).padStart(9)}  ${n}`).join('\n')
}

async function dumpOne(bot, spec, viewDistance) {
  const [target, yArg] = spec.split('@')
  const [kind, id] = target.split(':')
  let x, z
  if (kind === 'at') {
    [x, z] = id.split(',').map(Number)
  } else {
    const what = kind === 'biome' ? 'biome' : 'structure'
    const found = await consoleAwait(`locate ${what} minecraft:${id}`, new RegExp(`nearest minecraft:${id} is at \\[(-?\\d+), (~|-?\\d+), (-?\\d+)\\]|Could not find a ${what} of type "?minecraft:${id}`), 90000)
    if (!found || found[1] === undefined) return { spec, error: found ? 'none nearby' : 'locate timed out' }
    x = Number(found[1]); z = Number(found[3])
  }
  // Hover high first so the column loads, then stand where asked.
  consoleCmd(`tp ${NAME} ${x} 320 ${z}`)
  await settle(bot, viewDistance)
  const y = yArg === undefined ? surfaceY(bot, x, z) : Number(yArg)
  if (y === null) return { spec, error: 'no ground at the target column' }
  consoleCmd(`tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(2000)
  const s = await settle(bot, viewDistance)
  const r = countLoaded(bot)
  const p = bot.entity.position.floored()
  const feet = bot.blockAt(p)?.name, floor = bot.blockAt(p.offset(0, -1, 0))?.name
  return { spec, at: { x, y, z }, probe: { x: p.x, y: p.y, z: p.z }, feet, floor, viewDistance,
    chunks: r.chunks, columns: r.columns, missingInView: s.missing, counts: sorted(r.counts) }
}

async function main() {
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: VERSION })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); setTimeout(() => rej(new Error('spawn timeout')), 60000) })
  consoleCmd(`gamemode creative ${NAME}`)   // stands like a player, but can't drown or suffocate at depth
  await sleep(2000)
  const viewDistance = Number(process.env.VIEW_DISTANCE || 10)   // server.properties view-distance
  for (const spec of specs) {
    const out = await dumpOne(bot, spec, viewDistance)
    console.log(`\n=== ${spec} ===`)
    if (out.error) { console.log(`  ${out.error}`); continue }
    fs.writeFileSync(path.join(OUT_DIR, `${spec.replace(/[:@,]/g, '_')}.json`), JSON.stringify(out, null, 1))
    console.log(`  standing @${out.probe.x},${out.probe.y},${out.probe.z} (feet=${out.feet}, floor=${out.floor})  ${out.chunks} chunks loaded`)
    console.log(table(new Map(out.counts), 40))
  }
  bot.quit()
  setTimeout(() => process.exit(0), 500)
}

main().catch(e => { console.error(e); process.exit(1) })
