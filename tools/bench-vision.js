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
const { castVisionRays } = require('../src/perception/vision')
const ranges = require('../src/config/ranges')

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
  const rayT = [], rayBA = []
  let lastNav = null, lastVis = null, lastRay = null

  for (let i = 0; i < ITER + 3; i++) {
    // rotate the bot each iteration so surveyVisible's cone samples varied terrain
    await bot.look((i / (ITER + 3)) * Math.PI * 2, 0, true)

    blockAtCalls = 0
    const r = surveyForNav({})
    const nBA = blockAtCalls
    if (!r) { console.error('surveyForNav returned null'); process.exit(1) }

    // Exactly what bot.js:265 runs on the ambient tick — measuring anything else
    // gives a number that does not correspond to a cost the bot actually pays.
    blockAtCalls = 0
    const t0 = performance.now()
    const v = surveyVisible({
      maxDistance: ranges.sight.ambientSurveyBlocks,
      fovDegrees: ranges.sight.ambientFovDegrees,
      cap: ranges.sight.ambientSurveyCap,
      visibleCap: ranges.sight.ambientVisibleCap,
    })
    const vT = performance.now() - t0
    const vBA = blockAtCalls

    // castVisionRays shares the ambient 3s interval with surveyVisible (bot.js:265),
    // so the tick's real cost is the sum of all three.
    blockAtCalls = 0
    const t1 = performance.now()
    const cv = castVisionRays(8, ranges.sight.rayScanBlocks)
    const cT = performance.now() - t1
    const cBA = blockAtCalls

    if (i < 3) continue // warmup: JIT + sqlite page cache
    navT.push(r.tTotal); navScan.push(r.tScan); navLos.push(r.tLos); navWrite.push(r.tWrite); navBA.push(nBA)
    visT.push(vT); visBA.push(vBA)
    rayT.push(cT); rayBA.push(cBA)
    lastNav = r; lastVis = v; lastRay = cv
  }

  // ── radius sweep ─────────────────────────────────────────────────────
  // The whole point of making perception cheap is to afford seeing further. This is the
  // cost curve: candidate count grows ~r^3 until it saturates the `count` cap, and LOS
  // ray length grows with r, so the scaling is worse than linear. Read it before
  // raising ranges.sight — the budget is what a 100ms engine tick can absorb.
  if (process.env.BENCH_SWEEP === '1') {
    // Two axes, because they are NOT interchangeable: scanCandidates sorts by distance
    // and keeps the nearest `maxCandidates`, so raising maxDistance alone just scans
    // more chunks and discards the extra. Radius sets how far you *could* see; the cap
    // sets how much of it you actually process.
    console.log('A. radius at production cap (2000) — extra range is scanned then discarded\n')
    console.log('    r   candidates   writes    scan     los   write   total')
    for (const r of [16, 24, 32, 48, 64]) {
      const ts = [], sc = [], ls = [], wr = []
      let last = null
      for (let i = 0; i < 7; i++) {
        const res = surveyForNav({ maxDistance: r, passableRange: 22, maxCandidates: 2000 })
        if (i < 2) continue
        ts.push(res.tTotal); sc.push(res.tScan); ls.push(res.tLos); wr.push(res.tWrite); last = res
      }
      console.log(`  ${String(r).padStart(3)}   ${String(last.candidates).padStart(10)}   ${String(last.writes).padStart(6)}` +
        `  ${stats(sc).med.toFixed(1).padStart(6)}  ${stats(ls).med.toFixed(1).padStart(6)}` +
        `  ${stats(wr).med.toFixed(1).padStart(6)}  ${stats(ts).med.toFixed(1).padStart(6)}`)
    }

    console.log('\nB. candidate cap at r32 — the axis that actually adds knowledge\n')
    console.log(  '  cap   candidates   writes    scan     los   write   total')
    for (const cap of [2000, 4000, 8000, 16000]) {
      const ts = [], sc = [], ls = [], wr = []
      let last = null
      for (let i = 0; i < 7; i++) {
        const res = surveyForNav({ maxDistance: 32, passableRange: 22, maxCandidates: cap })
        if (i < 2) continue
        ts.push(res.tTotal); sc.push(res.tScan); ls.push(res.tLos); wr.push(res.tWrite); last = res
      }
      console.log(`  ${String(cap).padStart(4)}  ${String(last.candidates).padStart(10)}   ${String(last.writes).padStart(6)}` +
        `  ${stats(sc).med.toFixed(1).padStart(6)}  ${stats(ls).med.toFixed(1).padStart(6)}` +
        `  ${stats(wr).med.toFixed(1).padStart(6)}  ${stats(ts).med.toFixed(1).padStart(6)}`)
    }

    console.log('\nC. full survey (cap 20000) — true cost of actually seeing that far\n')
    console.log(  '    r   candidates   writes    scan     los   write   total')
    for (const r of [16, 24, 32, 48, 64, 80]) {
      const ts = [], sc = [], ls = [], wr = []
      let last = null
      for (let i = 0; i < 7; i++) {
        const res = surveyForNav({ maxDistance: r, passableRange: Math.round(r * 0.7), maxCandidates: 20000 })
        if (i < 2) continue
        ts.push(res.tTotal); sc.push(res.tScan); ls.push(res.tLos); wr.push(res.tWrite); last = res
      }
      console.log(`  ${String(r).padStart(3)}   ${String(last.candidates).padStart(10)}   ${String(last.writes).padStart(6)}` +
        `  ${stats(sc).med.toFixed(1).padStart(6)}  ${stats(ls).med.toFixed(1).padStart(6)}` +
        `  ${stats(wr).med.toFixed(1).padStart(6)}  ${stats(ts).med.toFixed(1).padStart(6)}`)
    }
    console.log()
    bot.quit(); process.exit(0)
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

  console.log(`surveyVisible (${lastVis.fov}° r${lastVis.maxDistance}, ${lastVis.candidatesScanned} scanned, ${lastVis.losTests} los tests)`)
  console.log(row('total', stats(visT)))
  console.log(`  bot.blockAt    ${Math.round(stats(visBA).med)} calls/survey\n`)

  console.log(`castVisionRays (res 8, r${ranges.sight.rayScanBlocks}, ${lastRay?.allBlocks?.length ?? 0} blocks)`)
  console.log(row('total', stats(rayT)))
  console.log(`  bot.blockAt    ${Math.round(stats(rayBA).med)} calls/cast\n`)

  const tick = stats(visT).med + stats(rayT).med
  console.log(`ambient 3s tick (surveyVisible + castVisionRays): ${tick.toFixed(1)}ms blocking`)

  bot.quit()
  process.exit(0)
}

main().catch(e => { console.error('bench failed:', e.message); process.exit(1) })
