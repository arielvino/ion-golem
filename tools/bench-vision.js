#!/usr/bin/env node
// bench-vision.js — offline-ish perception benchmark.
//
// Connects a bare mineflayer bot to the local dev server (no engine, no AI), waits for
// chunks, then times the two survey paths that feed the DB and the model:
//   surveyForNav  — omni r32, writes to sqlite   (nav knowledge)
//   surveyVisible — 120° r40, no writes          (context `see=`)
// Reports per-phase splits (scan / los / write) plus a bot.blockAt call count, which is
// the number that decides whether the bottleneck is chunk discovery, LOS raycasting, or
// sqlite. Run it before and after a perception change to get a real delta.
//
// Usage: node tools/bench-vision.js [iterations]
const path = require('path')
const fs = require('fs')
const mineflayer = require('mineflayer')
const state = require('../src/core/state')

const ITER = parseInt(process.argv[2] || '15', 10)
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '1.21.11'

// Scratch runtime dir so the benchmark never touches a real character's memory.
const DATA_DIR = process.env.BENCH_DATA_DIR || path.join(__dirname, '..', '..', '.bench-runtime')
fs.mkdirSync(DATA_DIR, { recursive: true })
state.BOT_DATA_DIR = DATA_DIR

const { initDB } = require('../src/world/memory')
initDB()

const { surveyForNav, surveyVisible } = require('../src/perception/visibility')

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const sum = s.reduce((a, b) => a + b, 0)
  return { mean: sum / s.length, med: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] }
}
const f = (n) => n.toFixed(1).padStart(7)
const row = (label, st) => `  ${label.padEnd(14)} med ${f(st.med)}ms   mean ${f(st.mean)}ms   min ${f(st.min)}  max ${f(st.max)}`

async function main() {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'BenchBot', version: VERSION })
  state.bot = bot

  await new Promise((res, rej) => {
    bot.once('spawn', res)
    bot.once('error', rej)
    setTimeout(() => rej(new Error('spawn timeout')), 60000)
  })
  console.log(`connected: ${bot.version}  pos=${bot.entity.position.floored()}`)

  // Let the server stream chunks in; the survey cost depends entirely on how much
  // world is loaded, so benchmarking a half-loaded view distance is meaningless.
  let cols = 0
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const n = bot.world.getColumns().length
    if (n === cols && n > 40) break
    cols = n
  }
  console.log(`chunks loaded: ${cols} columns\n`)

  // Count bot.blockAt calls — the suspected hot path inside every LOS ray.
  let blockAtCalls = 0
  const origBlockAt = bot.blockAt.bind(bot)
  bot.blockAt = (p, ...rest) => { blockAtCalls++; return origBlockAt(p, ...rest) }

  const navT = [], navScan = [], navLos = [], navWrite = [], navBA = []
  const visT = [], visBA = []
  let lastNav = null, lastVis = null

  for (let i = 0; i < ITER + 3; i++) {
    // rotate the bot each iteration so surveyVisible's cone samples varied terrain
    await bot.look((i / (ITER + 3)) * Math.PI * 2, 0, true)

    blockAtCalls = 0
    const r = surveyForNav({})
    const nBA = blockAtCalls
    if (!r) { console.error('surveyForNav returned null'); process.exit(1) }

    blockAtCalls = 0
    const t0 = performance.now()
    const v = surveyVisible({ maxDistance: 40, fovDegrees: 120 })
    const vT = performance.now() - t0
    const vBA = blockAtCalls

    if (i < 3) continue // warmup: JIT + sqlite page cache
    navT.push(r.tTotal); navScan.push(r.tScan); navLos.push(r.tLos); navWrite.push(r.tWrite); navBA.push(nBA)
    visT.push(vT); visBA.push(vBA)
    lastNav = r; lastVis = v
  }

  const nt = stats(navT)
  console.log(`surveyForNav  (omni r32, ${lastNav.candidates} candidates, ${lastNav.writes} writes)`)
  console.log(row('total', nt))
  console.log(row('  scan', stats(navScan)))
  console.log(row('  los', stats(navLos)))
  console.log(row('  write', stats(navWrite)))
  const pct = (a) => ((stats(a).med / nt.med) * 100).toFixed(0).padStart(3)
  console.log(`  split          scan ${pct(navScan)}%   los ${pct(navLos)}%   write ${pct(navWrite)}%`)
  console.log(`  bot.blockAt    ${Math.round(stats(navBA).med)} calls/survey\n`)

  console.log(`surveyVisible (120° r40, ${lastVis.candidatesScanned} scanned, ${lastVis.losTests} los tests)`)
  console.log(row('total', stats(visT)))
  console.log(`  bot.blockAt    ${Math.round(stats(visBA).med)} calls/survey`)

  bot.quit()
  process.exit(0)
}

main().catch(e => { console.error('bench failed:', e.message); process.exit(1) })
