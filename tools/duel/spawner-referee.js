// Spawner referee: running bots against a real mob spawner in the world (a fortress
// blaze spawner, say), one bot at a time, round after round. It drives nothing in the
// bot: it gears it, puts it at the spawner, and lets the spawner do the rest for the
// round's time or until the bot dies. Kills and damage come from scoreboards; what the
// bot did, from its own log. Each round is appended to <data dir>/duel/spawner-results.jsonl.
//
// Variants take turns round by round (BotA, BotB, …, BotA, …), so a slow drift in the
// world (mobs wandering in, the time of day) spreads over all of them. Between rounds
// the spawner's surroundings are cleared of mobs and drops, and the bot that played
// goes back to where it was.
//
// The bots under test should be --no-ai --no-chat test bots (see mob-referee.js).
//
//   node tools/duel/spawner-referee.js --variants BotA:shield:no,BotB:noshield:yes
//     --spawner 202,63,-341 --stand 204.5,63,-339.5 [--dim the_nether] [--mob blaze]
//     [--rounds 10] [--time 90] [--clear 24]
// A variant is bot:kit:fire-resistance, kit as in mob-referee (shield|noshield|none).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { cmd, ask, logSize, logSince } = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const VARIANTS = (args.variants || '').split(',').filter(Boolean).map(v => {
  const [bot, kit = 'shield', fireRes = 'no'] = v.split(':')
  return { bot, kit, fireRes: fireRes === 'yes' }
})
if (!VARIANTS.length || !args.spawner || !args.stand) {
  console.error('usage: spawner-referee.js --variants Bot:kit:fireres,… --spawner x,y,z --stand x,y,z [--dim the_nether] [--mob blaze] [--rounds 10] [--time 90] [--clear 24]')
  process.exit(1)
}
const [SX, SY, SZ] = args.spawner.split(',').map(Number)
const [PX, PY, PZ] = args.stand.split(',').map(Number)
const DIM = `minecraft:${args.dim || 'the_nether'}`
const MOB = args.mob || 'blaze'
const ROUNDS = parseInt(args.rounds || '10', 10)
const TIME_MS = parseInt(args.time || '90', 10) * 1000
const CLEAR_R = parseInt(args.clear || '24', 10)
const NEAR = `x=${SX},y=${SY},z=${SZ},distance=..${CLEAR_R}`

const ARMOR = [
  ['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'],
  ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']
]
const GEAR_BAG = [['bow', 1], ['arrow', 32], ['cooked_beef', 8]]
const KITS = {
  shield: { hands: [['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']], bag: GEAR_BAG },
  noshield: { hands: [['weapon.mainhand', 'iron_sword']], bag: GEAR_BAG },
  none: { armor: false, hands: [], bag: [] }
}

const DATA = process.env.IONGOLEM_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'iongolem')
const RESULTS = path.join(DATA, 'duel', 'spawner-results.jsonl')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const deathRe = (bot) => new RegExp(`System chat: ${bot} (was|died|drowned|fell|hit the|burned|went up|tried|walked|experienced|blew|withered|starved|suffocated|froze|discovered)[^\\n]*`)

// Kills of the mob, and damage taken (the statistic counts tenths of a health point).
const KILLS = 'spawner_kills'
const DAMAGE = 'spawner_damage'
const score = async (bot, obj) => {
  const r = await ask(`scoreboard players get ${bot} ${obj}`, new RegExp(`${bot} has \\d+ \\[|Can't get value of ${obj} for ${bot}`))
  const m = r && r.match(/has (\d+)/)
  return m ? +m[1] : 0
}
const health = async (bot) => {
  const r = await ask(`data get entity ${bot} Health`, /has the following entity data: [\d.]+f|No entity was found|Found no elements/)
  const m = r && r.match(/([\d.]+)f/)
  return m ? +(+m[1]).toFixed(1) : null
}
const mobsNear = async () => {
  const r = await ask(`execute in ${DIM} if entity @e[type=${MOB},${NEAR}]`, /Test (passed|failed)(\. Count: \d+)?/)
  const m = r && r.match(/Count: (\d+)/)
  return m ? +m[1] : 0
}

// What the bot did between two wall-clock times, from its own log (lines stamped HH:MM:SS.mmm).
function botActions(bot, t0, t1) {
  const dir = path.join(DATA, bot, 'logs')
  const latest = fs.readdirSync(dir).filter(f => f.startsWith('bot-')).sort().pop()
  const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8)
  const [a, b] = [hhmmss(t0), hhmmss(t1)]
  const lines = fs.readFileSync(path.join(dir, latest), 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    .filter(l => { const t = l.slice(0, 8); return t >= a && t <= b })
  const count = (re) => lines.filter(l => re.test(l)).length
  return {
    actions: lines.map(l => (l.match(/\[BG\] launching: (\S+)/) || [])[1]).filter(Boolean),
    shield: count(/\[SHIELD\] up/), juke: count(/\[DODGE\]/), projSidestep: count(/\[PROJ\] .*→ sidestep/),
    hitsTaken: count(/\[AUTO\] hit by/)
  }
}

async function where(bot) {
  const r = await ask(`data get entity ${bot} Pos`, /has the following entity data: \[[^\]]+\]|No entity was found/)
  const m = r && r.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
  return m ? m.slice(1).map(Number) : null
}

async function gear(v) {
  const kit = KITS[v.kit]
  await cmd(`clear ${v.bot}`)
  await cmd(`effect clear ${v.bot}`)
  if (kit.armor !== false) for (const [slot, item] of ARMOR) await cmd(`item replace entity ${v.bot} ${slot} with ${item}`)
  for (const [slot, item] of kit.hands) await cmd(`item replace entity ${v.bot} ${slot} with ${item}`)
  for (const [item, count] of kit.bag) await cmd(`give ${v.bot} ${item} ${count}`)
  await cmd(`effect give ${v.bot} instant_health 1 10 true`)
  await cmd(`effect give ${v.bot} saturation 1 10 true`)
  if (v.fireRes) await cmd(`effect give ${v.bot} fire_resistance infinite 0 true`)
}

async function playRound(v, n) {
  await cmd(`execute in ${DIM} run kill @e[type=!player,${NEAR}]`)
  await gear(v)
  await cmd(`scoreboard players set ${v.bot} ${KILLS} 0`)
  await cmd(`scoreboard players set ${v.bot} ${DAMAGE} 0`)
  await cmd(`execute in ${DIM} run tp ${v.bot} ${PX} ${PY} ${PZ} facing ${SX + 0.5} ${SY + 0.5} ${SZ + 0.5}`)
  const from = logSize()
  const t0 = Date.now()
  let death = null
  while (Date.now() - t0 < TIME_MS) {
    const m = logSince(from).match(deathRe(v.bot))
    if (m) { death = m[0].replace('System chat: ', ''); break }
    await sleep(500)
  }
  const t1 = Date.now()
  const result = {
    t: new Date().toISOString(), round: n, bot: v.bot, mob: MOB, kit: v.kit, fireRes: v.fireRes,
    spawner: `${SX},${SY},${SZ}`, died: !!death, death,
    seconds: +((t1 - t0) / 1000).toFixed(1),
    kills: await score(v.bot, KILLS),
    damageTaken: +((await score(v.bot, DAMAGE)) / 10).toFixed(1),
    hp: death ? 0 : await health(v.bot),
    mobsLeft: await mobsNear(),
    ...botActions(v.bot, t0, t1)
  }
  console.log(`Round ${n} ${v.bot} (${v.kit}${v.fireRes ? ', fire res' : ''}): ` +
    `${death ? `DIED after ${result.seconds}s (${death})` : `alive, hp ${result.hp}`}; ` +
    `${result.kills} ${MOB} killed, ${result.damageTaken} damage taken, ${result.mobsLeft} left; ` +
    `shield ${result.shield}, juke ${result.juke}, sidestep ${result.projSidestep}, hit ${result.hitsTaken}x`)
  fs.appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  return result
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  // Where each bot was, to put it back between its rounds and at the end.
  const homes = {}
  for (const v of VARIANTS) {
    const p = await where(v.bot)
    if (!p) { console.error(`${v.bot} is not online`); process.exit(1) }
    homes[v.bot] = p
  }
  await cmd(`scoreboard objectives add ${KILLS} minecraft.killed:minecraft.${MOB}`)
  await cmd(`scoreboard objectives add ${DAMAGE} minecraft.custom:minecraft.damage_taken`)
  console.log(`Spawner at ${SX} ${SY} ${SZ} in ${DIM}; bots stand at ${PX} ${PY} ${PZ}`)

  const results = []
  for (let n = 1; n <= ROUNDS; n++) {
    for (const v of VARIANTS) {
      results.push(await playRound(v, n))
      const [x, y, z] = homes[v.bot]
      await sleep(3000)   // a bot that died respawns first
      await cmd(`execute in minecraft:overworld run tp ${v.bot} ${x} ${y} ${z}`)
    }
  }

  console.log('')
  for (const v of VARIANTS) {
    const rs = results.filter(r => r.bot === v.bot)
    const avg = (k) => (rs.reduce((a, r) => a + (+r[k] || 0), 0) / rs.length).toFixed(1)
    console.log(`== ${v.bot} (${v.kit}${v.fireRes ? ', fire res' : ''}): died ${rs.filter(r => r.died).length}/${rs.length}, ` +
      `${avg('kills')} ${MOB} killed, ${avg('damageTaken')} damage taken, ${avg('seconds')}s per round, shield ${avg('shield')}, hit ${avg('hitsTaken')}x`)
  }
  console.log(`results appended to ${RESULTS}`)
  await cmd(`execute in ${DIM} run kill @e[type=!player,${NEAR}]`)
}

main().catch(e => { console.error(e); process.exit(1) })
