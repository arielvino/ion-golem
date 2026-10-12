// Mob referee: a running bot (bot.js, its own AI and reflexes) against a mob, round
// after round, in an arena of its own. It drives nothing in the bot: it gears it,
// puts it in a corner, summons the mob in the far one, and watches the server log
// and console replies for who dies. Each round, with what the bot did (from its own
// log), is appended to <data dir>/duel/mob-results.jsonl.
//
// The bot under test should be a --no-ai --no-chat test bot (node bot.js BotX --debug
// --no-ai --no-chat): the reflexes and defend do the fighting, and an AI bot takes a
// model turn for every death and chat line on the server. Use an AI bot only when
// its choices are what's being measured, and ask the user first.
//
//   node tools/duel/mob-referee.js [--bot BotTest] [--mob skeleton] [--rounds 30] [--time 90] [--at 40,0] [--r 12] [--kit shield|noshield|none] [--feed no]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeArena, cmd, ask, logSize, logSince } = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const BOT = args.bot || 'BotTest'
const MOB = args.mob || 'skeleton'
const ROUNDS = parseInt(args.rounds || '30', 10)
const TIME_MS = parseInt(args.time || '90', 10) * 1000
const [CX, CZ] = (args.at || '40,0').split(',').map(Number)
// --feed no: no saturation top-up each round, so regeneration runs at what the bot's
// own food allows (a fed bot out-heals Wither I).
const FEED = args.feed !== 'no'
const arena = makeArena({ cx: CX, cz: CZ, r: parseInt(args.r || '12', 10) })

// Iron armour (from prepare), a sword (and shield) in hand, a bow and food in the bag;
// none: bare-handed, no armour, nothing in the bag.
const GEAR_BAG = [['bow', 1], ['arrow', 32], ['cooked_beef', 8]]
const KITS = {
  shield: { hands: [['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']], bag: GEAR_BAG },
  noshield: { hands: [['weapon.mainhand', 'iron_sword']], bag: GEAR_BAG },
  none: { armor: false, hands: [], bag: [] }
}
const KIT = KITS[args.kit || 'shield']
// The mob's own gear: summoning with NBT skips its spawn equipment.
const MOB_GEAR = {
  skeleton: 'equipment:{mainhand:{id:"minecraft:bow",count:1}},',
  wither_skeleton: 'equipment:{mainhand:{id:"minecraft:stone_sword",count:1}},'
}
// After a win, wait at most this long for the mob's lingering effects to wear off.
const SETTLE_MS = 20000
const LINGERING_RE = /minecraft:(wither|poison)"/
const TAG = `mobduel_${BOT}`   // per bot: referees can run side by side

const DATA = process.env.IONGOLEM_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'iongolem')
const RESULTS = path.join(DATA, 'duel', 'mob-results.jsonl')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const DEATH_RE = new RegExp(`System chat: ${BOT} (was|died|drowned|fell|hit the|burned|went up|tried|walked|experienced|blew|withered|starved|suffocated|froze)`)

const health = async (sel) => {
  const r = await ask(`data get entity ${sel} Health`, /has the following entity data: [\d.]+f|No entity was found|Found no elements/)
  const m = r && r.match(/([\d.]+)f/)
  return m ? +(+m[1]).toFixed(1) : null
}
const mobAlive = async () =>
  /passed/.test(await ask(`execute if entity @e[type=${MOB},tag=${TAG},${arena.box}]`, /Test (passed|failed)/) || '')

// What the bot did between two wall-clock times, from its own log (lines stamped HH:MM:SS.mmm).
function botActions(t0, t1) {
  const dir = path.join(DATA, BOT, 'logs')
  const latest = fs.readdirSync(dir).filter(f => f.startsWith('bot-')).sort().pop()
  const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8)
  const [a, b] = [hhmmss(t0), hhmmss(t1)]
  const lines = fs.readFileSync(path.join(dir, latest), 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    .filter(l => { const t = l.slice(0, 8); return t >= a && t <= b })
  const count = (re) => lines.filter(l => re.test(l)).length
  return {
    actions: lines.map(l => (l.match(/\[BG\] launching: (\S+)/) || [])[1]).filter(Boolean),
    shield: count(/\[SHIELD\] up|\[PROJ\] .*→ shield/), juke: count(/\[DODGE\]/), projSidestep: count(/\[PROJ\] .*→ sidestep/),
    hitsTaken: count(/\[AUTO\] hit by/)
  }
}

async function playRound(n) {
  await arena.sweep()
  await arena.prepare(BOT, 'blue', KIT, 0)
  if (FEED) await cmd(`effect give ${BOT} saturation 1 10 true`)
  const m = arena.corner(1)
  await cmd(`summon ${MOB} ${m.x} ${m.y} ${m.z} {${MOB_GEAR[MOB] || ''}Tags:["${TAG}"],PersistenceRequired:1b}`)
  await sleep(500)
  const from = logSize()
  const t0 = Date.now()
  let winner = 'draw'
  while (Date.now() - t0 < TIME_MS) {
    if (DEATH_RE.test(logSince(from))) { winner = MOB; break }
    if (!await mobAlive()) { winner = BOT; break }
    await sleep(300)
  }
  const t1 = Date.now()
  const botHp = winner === MOB ? 0 : await health(BOT)
  // A win isn't over while the mob's poison works on: wait, unhealed, for Wither or
  // Poison to wear off (or kill the bot), and record what it cost.
  // Regeneration can outpace Wither I, so the settled health hides the damage: sum
  // the drops too (polled every ~0.5 s).
  let settled = botHp, diedAfter = false, effectSeconds = 0, effectDamage = 0
  if (winner === BOT) {
    const s0 = Date.now()
    let last = botHp
    while (Date.now() - s0 < SETTLE_MS) {
      if (DEATH_RE.test(logSince(from))) { diedAfter = true; effectDamage += last || 0; settled = 0; break }
      const hp = await health(BOT)
      if (hp !== null && last !== null && hp < last) effectDamage += last - hp
      last = hp
      if (!LINGERING_RE.test(await ask(`data get entity ${BOT} active_effects`, new RegExp(`${BOT} has the following entity data: .*|Found no elements.*`)) || '')) break
      await sleep(500)
    }
    effectSeconds = +((Date.now() - s0) / 1000).toFixed(1)
    if (!diedAfter) settled = await health(BOT)
  }
  const result = {
    t: new Date().toISOString(), round: n, bot: BOT, mob: MOB, kit: args.kit || 'shield', fed: FEED, arena: `${CX},${CZ}`, winner,
    seconds: +((t1 - t0) / 1000).toFixed(1),
    botHp, settledHp: settled, diedAfter, effectSeconds, effectDamage: +effectDamage.toFixed(1),
    mobHp: winner === BOT ? 0 : await health(`@e[type=${MOB},tag=${TAG},${arena.box},limit=1]`),
    ...botActions(t0, t1)
  }
  console.log(`Round ${n}: ${winner === 'draw' ? 'DRAW (time)' : `${winner} WINS`} in ${result.seconds}s — ` +
    `hp ${BOT} ${result.botHp}${winner === BOT ? ` → ${diedAfter ? 'DIED' : settled} after ${effectSeconds}s of effects (−${effectDamage.toFixed(1)})` : ''} / ${MOB} ${result.mobHp}; ` +
    `actions ${result.actions.join(', ') || 'none'}; ` +
    `shield ${result.shield}, juke ${result.juke}, sidestep ${result.projSidestep}, hit ${result.hitsTaken}x`)
  if (diedAfter) await sleep(3000)
  fs.appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  if (winner === MOB) await sleep(3000)   // respawn on the roof before the next round's teleport
  return result
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  // Where the bot was, to put it back afterwards.
  const pos = await ask(`data get entity ${BOT} Pos`, /has the following entity data: \[[^\]]+\]|No entity was found/)
  const home = pos && pos.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
  if (!home) { console.error(`${BOT} is not online`); process.exit(1) }
  console.log(`Arena at ${CX},${CZ}: ${await arena.ready()}; spectate from ${arena.VIEW.x} ${arena.VIEW.y} ${arena.VIEW.z}`)

  const results = []
  for (let n = 1; n <= ROUNDS; n++) results.push(await playRound(n))

  const wins = (w) => results.filter(r => r.winner === w).length
  const avg = (k) => (results.reduce((a, r) => a + (r[k] || 0), 0) / results.length).toFixed(1)
  console.log(`\n== ${BOT} ${wins(BOT)} : ${wins(MOB)} ${MOB} (${wins('draw')} draws) ==` +
    (results.some(r => r.effectDamage) ? `; ${results.filter(r => r.diedAfter).length} wins died afterwards to lingering effects, avg hp ${avg('botHp')} at the kill → ${avg('settledHp')} settled, effects dealt ${avg('effectDamage')} per win` : ''))
  console.log(`avg round ${avg('seconds')}s, avg ${BOT} hp left ${avg('botHp')}, shield ${avg('shield')}, juke ${avg('juke')}, sidestep ${avg('projSidestep')}, hits taken ${avg('hitsTaken')} per round`)
  console.log(`results appended to ${RESULTS}`)

  await arena.sweep()
  const [x, y, z] = home.slice(1)
  await cmd(`tp ${BOT} ${x} ${y} ${z}`)
  await cmd(`spawnpoint ${BOT} ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`)
  await cmd(`team leave ${BOT}`)
}

main().catch(e => { console.error(e); process.exit(1) })
