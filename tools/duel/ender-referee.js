// Enderman referee: a running test bot (bot.js --no-ai --no-chat) wanders the outer
// End islands, away from the dragon, and a spectator client riding along measures
// how often the bot provokes endermen by looking at them, and what that costs it.
// The referee only stages and steers (random `!act goto` legs on end stone); the
// bot's own head movement and reflexes are what's measured.
//
// For every enderman within 64 blocks, every tick, it records:
//   gaze     — the bot's look passes vanilla's stare test (dot > 1 - 0.025/dist, from
//              the bot's eyes to the enderman's) with line of sight: our estimate
//   stared   — the enderman's own `stared_at` flag rising: the server's verdict that
//              a stare provoked it
//   aggro    — its `creepy` flag rising (it took a target), put down to a stare when
//              `stared` rose within the 3 s before, otherwise to something else
// plus the hits the bot takes while an angry enderman is close, and deaths. The run
// is appended to <data dir>/duel/ender-results.jsonl.
//
//   node tools/duel/ender-referee.js [--bot BotEnder] [--minutes 20] [--at 1500,0] [--kit iron|none]
const fs = require('fs')
const os = require('os')
const path = require('path')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { cmd, ask, logSize, logSince } = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const BOT = args.bot || 'BotEnder'
const OBS = args.obs || 'EndObs'
const MINUTES = parseFloat(args.minutes || '20')
const [AX, AZ] = (args.at || '1500,0').split(',').map(Number)
const KIT = args.kit || 'iron'
const RANGE = 64
const BOT_EYE = 1.62
const STARE_WINDOW_MS = 3000
const LEG_MS = 40000

const DATA = process.env.IONGOLEM_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'iongolem')
const RESULTS = path.join(DATA, 'duel', 'ender-results.jsonl')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const end = (line) => cmd(`execute in minecraft:the_end run ${line}`)
const DEATH_RE = new RegExp(`(${BOT} (?:was|died|fell|hit the|tried|walked|experienced|starved|suffocated|left the confines)[^\\n]*)`, 'g')

const obs = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  version: process.env.MC_VERSION || '26.3',
  username: OBS
})

const tops = (center, r) => obs.findBlocks({ matching: (b) => b && b.name === 'end_stone', point: center, maxDistance: r, count: 20000 })
  .filter(p => obs.blockAt(p.offset(0, 1, 0))?.name === 'air' && obs.blockAt(p.offset(0, 2, 0))?.name === 'air')

// An outer island with room to walk: the first candidate centre whose loaded chunks
// hold enough end stone surface, and the surface block nearest that surface's middle.
async function findIsland() {
  const centres = [[AX, AZ], [-AX, AZ], [AZ, AX], [AZ, -AX], [AX, AX], [-AX, -AX]]
  for (const [x, z] of centres) {
    await end(`tp ${OBS} ${x} 100 ${z}`)
    await sleep(6000)
    const s = tops(new Vec3(x, 60, z), 64)
    console.log(`  island search at ${x},${z}: ${s.length} surface blocks`)
    if (s.length < 400) continue
    const mid = s.reduce((a, p) => a.plus(p), new Vec3(0, 0, 0)).scaled(1 / s.length)
    return s.reduce((a, p) => (p.distanceTo(mid) < a.distanceTo(mid) ? p : a))
  }
  return null
}

// The next walk: a surface block 8–24 blocks from the bot, on the bot's island
// (not more than 6 blocks above or below it).
function nextLeg(from) {
  const s = tops(from, 24).filter(p => {
    const d = p.distanceTo(from)
    return d >= 8 && Math.abs(p.y - from.y) <= 6
  })
  return s.length ? s[Math.floor(Math.random() * s.length)] : null
}

function lookVector(e) {
  return new Vec3(-Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(e.yaw) * Math.cos(e.pitch))
}

// Vanilla's EnderMan.isBeingStaredBy, minus the pumpkin: the bot's look within
// 0.025/dist of the line from its eyes to the enderman's, and nothing in between.
function gazes(botE, ender) {
  const eye = botE.position.offset(0, BOT_EYE, 0)
  const head = ender.position.offset(0, (ender.height || 2.9) * 0.88, 0)
  const to = head.minus(eye)
  const dist = to.norm()
  if (dist > RANGE) return false
  const dot = lookVector(botE).dot(to.scaled(1 / dist))
  if (dot <= 1 - 0.025 / dist) return false
  const hit = obs.world.raycast(eye, to.scaled(1 / dist), dist)
  return !hit
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  await new Promise(r => obs.once('spawn', r))
  const md = require('minecraft-data')(obs.version)
  const keys = md.entitiesByName.enderman.metadataKeys
  const CREEPY = keys.indexOf('creepy')
  const STARED = keys.indexOf('stared_at')

  const pos = await ask(`data get entity ${BOT} Pos`, new RegExp(`${BOT} has the following entity data: \\[[^\\]]+\\]|No entity was found`))
  if (!pos || /No entity/.test(pos)) { console.error(`${BOT} is not online`); process.exit(1) }

  await cmd(`gamemode spectator ${OBS}`)
  const spot = await findIsland()
  if (!spot) { console.error('no outer island found'); process.exit(1) }
  console.log(`Island at ${spot.x} ${spot.y} ${spot.z}`)

  await cmd(`gamemode survival ${BOT}`)
  await cmd(`clear ${BOT}`)
  if (KIT === 'iron') {
    for (const [slot, item] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'],
      ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots'], ['weapon.mainhand', 'iron_sword']]) {
      await cmd(`item replace entity ${BOT} ${slot} with ${item}`)
    }
    await cmd(`give ${BOT} cooked_beef 16`)
  }
  await end(`tp ${BOT} ${spot.x + 0.5} ${spot.y + 1} ${spot.z + 0.5}`)
  await end(`spawnpoint ${BOT} ${spot.x} ${spot.y + 1} ${spot.z}`)
  await cmd(`effect give ${BOT} instant_health 1 10 true`)
  await cmd(`effect give ${BOT} saturation 1 10 true`)
  await sleep(2000)

  const t0 = Date.now()
  let until = t0 + MINUTES * 60000
  // Stopped early (Ctrl-C, kill): finish the current pass and still write the results.
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { until = 0 })
  const logFrom = logSize()
  const tally = { gazeTicks: 0, gazeEpisodes: 0, stared: 0, aggro: 0, aggroByStare: 0, aggroOther: 0, hits: 0, damage: 0, legs: 0, exposureS: 0, nearS: 0 }
  const seen = new Set()
  const flags = new Map()          // enderman id -> { creepy, stared, staredAt, gazing }
  const events = []
  const at = () => +((Date.now() - t0) / 1000).toFixed(1)
  let lastHp = null

  obs.on('physicsTick', () => {
    const botE = obs.players[BOT]?.entity
    if (!botE) return
    let exposed = false, near = false
    for (const e of Object.values(obs.entities)) {
      if (e.name !== 'enderman') continue
      const d = e.position.distanceTo(botE.position)
      if (d > RANGE) continue
      seen.add(e.id)
      near = near || d < 16
      const f = flags.get(e.id) || { creepy: false, stared: false, staredAt: 0, gazing: false }
      const g = gazes(botE, e)
      if (g) { tally.gazeTicks++; exposed = true }
      if (g && !f.gazing) { tally.gazeEpisodes++; events.push({ t: at(), ev: 'gaze', id: e.id, d: +d.toFixed(1) }) }
      f.gazing = g
      const creepy = !!e.metadata[CREEPY], stared = !!e.metadata[STARED]
      if (stared && !f.stared) {
        tally.stared++; f.staredAt = Date.now()
        events.push({ t: at(), ev: 'stared', id: e.id, d: +d.toFixed(1) })
      }
      if (creepy && !f.creepy) {
        const byStare = Date.now() - f.staredAt < STARE_WINDOW_MS
        tally.aggro++; byStare ? tally.aggroByStare++ : tally.aggroOther++
        events.push({ t: at(), ev: 'aggro', id: e.id, d: +d.toFixed(1), cause: byStare ? 'stare' : 'other' })
        console.log(`  [${at()}s] enderman ${e.id} aggro at ${d.toFixed(1)}m (${byStare ? 'stare' : 'other'})`)
      }
      f.creepy = creepy; f.stared = stared
      flags.set(e.id, f)
    }
    if (exposed) tally.exposureS += 0.05
    if (near) tally.nearS += 0.05
  })

  // Hits the bot takes with an angry enderman within 5 blocks.
  obs.on('entityHurt', (e) => {
    if (e.username !== BOT) return
    const close = Object.values(obs.entities).some(x => x.name === 'enderman' && flags.get(x.id)?.creepy &&
      x.position.distanceTo(e.position) < 5)
    if (!close) return
    tally.hits++
    events.push({ t: at(), ev: 'hit' })
  })

  let legUntil = 0, target = null
  while (Date.now() < until) {
    const botE = obs.players[BOT]?.entity
    await cmd(`tp ${OBS} ${BOT}`)
    if (botE) {
      if (!target || Date.now() > legUntil || botE.position.distanceTo(target) < 2.5) {
        target = nextLeg(botE.position.floored())
        if (target) {
          tally.legs++
          legUntil = Date.now() + LEG_MS
          await cmd(`tellraw ${BOT} {"text":"<Tester> !act goto:${target.x},${target.y + 1},${target.z}"}`)
        }
      }
    }
    const hp = await ask(`data get entity ${BOT} Health`, new RegExp(`${BOT} has the following entity data: [\\d.]+f|No entity was found`))
    const h = hp && hp.match(/([\d.]+)f/)
    if (h) { if (lastHp !== null && +h[1] < lastHp) tally.damage += lastHp - +h[1]; lastHp = +h[1] }
    await sleep(3000)
  }

  const deaths = [...logSince(logFrom).matchAll(DEATH_RE)].map(m => m[1])
  const result = {
    t: new Date().toISOString(), bot: BOT, kit: KIT, minutes: MINUTES, island: [spot.x, spot.y, spot.z],
    endermenSeen: seen.size, ...tally,
    exposureS: +tally.exposureS.toFixed(1), nearS: +tally.nearS.toFixed(1), damage: +tally.damage.toFixed(1),
    deaths, events
  }
  fs.appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  const { events: _, ...summary } = result
  console.log('\n== ' + JSON.stringify(summary))
  console.log(`results appended to ${RESULTS}`)
  obs.quit()
}

main().catch(e => { console.error(e); process.exit(1) })
