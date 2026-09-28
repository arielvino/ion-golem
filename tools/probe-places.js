#!/usr/bin/env node
// probe-places.js — field test for place recognition against real generated structures.
//
// Connects a bare mineflayer bot (no engine, no AI) to the local dev server, and for each
// structure: asks the server console to `locate` it, drops the probe on the surface next to
// it with `spreadplayers`, waits for chunks, then runs recognize() and prints the verdict.
// Drives the server through its console FIFO, so it needs the local server started by
// minecraft-launch (server/server.stdin + server/server.log). Every command targets only
// the probe, never other players.
//
// Usage: node tools/probe-places.js [structure ...]   (default: the SURFACE list below)
//   structure = a structure id (village_desert), optionally prefixed with a dimension
//   (the_nether:fortress).
const path = require('path')
const fs = require('fs')
const mineflayer = require('mineflayer')
const state = require('../src/core/state')

const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '26.1'
const NAME = process.env.PROBE_NAME || 'PlacesProbe'
const RADIUS = parseInt(process.env.PROBE_RADIUS || '64', 10)
const SERVER_DIR = path.join(__dirname, '..', '..', 'server')
const STDIN = path.join(SERVER_DIR, 'server.stdin')
const LOG = path.join(SERVER_DIR, 'server.log')

const SURFACE = [
  'village_plains', 'village_desert', 'village_savanna', 'village_taiga', 'village_snowy',
  'pillager_outpost', 'desert_pyramid', 'swamp_hut', 'ruined_portal', 'monument',
  'the_nether:fortress', 'the_nether:bastion_remnant', 'the_nether:ruined_portal_nether',
]

// Scratch runtime dir so the probe never touches a real character's memory.
const DATA_DIR = process.env.PROBE_DATA_DIR || path.join(__dirname, '..', '..', '.probe-runtime')
fs.mkdirSync(DATA_DIR, { recursive: true })
state.BOT_DATA_DIR = DATA_DIR
require('../src/world/memory').initDB()
const { recognize, formatRecognition } = require('../src/perception/recognize')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const consoleCmd = (cmd) => fs.appendFileSync(STDIN, cmd + '\n')

// Send a console command and wait for a server.log line matching `re` (only lines
// written after the command). Returns the match, or null on timeout.
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

async function probe(bot, spec) {
  const [dim, id] = spec.includes(':') ? spec.split(':') : ['overworld', spec]
  const inDim = `execute in minecraft:${dim} run`
  const found = await consoleAwait(`${inDim} locate structure minecraft:${id}`,
    new RegExp(`nearest minecraft:${id} is at \\[(-?\\d+), (~|-?\\d+), (-?\\d+)\\]|Could not find a structure of type "?minecraft:${id}`))
  if (!found || found[1] === undefined) return { spec, error: found ? 'none nearby' : 'locate timed out' }
  const x = Number(found[1]), z = Number(found[3])

  // Surface drop next to the structure; in the nether stay under the bedrock roof.
  const under = dim === 'the_nether' ? 'under 100 ' : ''
  const moved = new Promise(res => bot.once('forcedMove', res))
  const ok = await consoleAwait(`${inDim} spreadplayers ${x} ${z} 0 12 ${under}false ${NAME}`,
    /Spread \d+ (?:entity|player)|Could not spread/, 60000)
  if (!ok || /Could not/.test(ok[0])) {
    // no land to stand on (an ocean monument): hover above sea level instead
    const tp = await consoleAwait(`${inDim} tp ${NAME} ${x} 70 ${z}`, /Teleported/, 30000)
    if (!tp) return { spec, error: 'spreadplayers and tp failed', at: { x, z } }
  }
  await Promise.race([moved, sleep(10000)])
  await sleep(8000) // let the chunks around the new position stream in

  const r = recognize({ maxDistance: RADIUS })
  const p = bot.entity.position.floored()
  return { spec, at: { x, z }, probe: { x: p.x, y: p.y, z: p.z }, dimension: bot.game.dimension, result: r }
}

async function main() {
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : SURFACE
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: VERSION })
  state.bot = bot
  await new Promise((res, rej) => {
    bot.once('spawn', res)
    bot.once('error', rej)
    setTimeout(() => rej(new Error('spawn timeout')), 60000)
  })
  // Creative so mobs and falls can't end the run; the probe only looks.
  consoleCmd(`gamemode creative ${NAME}`)
  await sleep(3000)

  const summary = []
  for (const spec of specs) {
    const out = await probe(bot, spec)
    console.log(`\n=== ${spec} ===`)
    if (out.error) {
      console.log(`  ${out.error}`)
      summary.push(`${spec.padEnd(34)} ${out.error}`)
      continue
    }
    const r = out.result
    console.log(`  structure @${out.at.x},${out.at.z}  probe @${out.probe.x},${out.probe.y},${out.probe.z} (${out.dimension})`)
    console.log(formatRecognition(r).split('\n').map(l => '  ' + l).join('\n'))
    console.log(`  ${r.visible} visible cues / ${r.losTests} los / ${r.candidates} scanned in ${r.ms}ms`)
    const top = r.places.flatMap(p => p.hyps.slice(0, 1).map(h => `${h.variant ? `${h.kind}(${h.variant})` : h.kind} ${h.share.toFixed(2)} @${p.dist}m`))
    summary.push(`${spec.padEnd(34)} ${top.join(', ') || '— nothing recognized'}`)
  }
  console.log('\n=== summary ===\n' + summary.join('\n'))
  bot.quit()
  setTimeout(() => process.exit(0), 500)
}

main().catch(e => { console.error(e); process.exit(1) })
