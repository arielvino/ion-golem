// Survival referee: a running bot (bot.js, its own AI and reflexes) alone in a big,
// dark arena where monsters spawn naturally, round after round. A round is won by
// staying alive for --minutes. Like the mob referee it drives nothing in the bot:
// it gears it, puts it in the middle, and watches. Each round, with the mobs that
// were around and what the bot did, is appended to
// <data dir>/duel/survival-results.jsonl.
//
// The bot under test should be a --no-ai --no-chat test bot (node bot.js BotX --debug
// --no-ai --no-chat): the reflexes and defend do the fighting, and an AI bot takes a
// model turn for every death and chat line on the server. Use an AI bot only when
// its choices are what's being measured, and ask the user first.
//
//   node tools/duel/survival-referee.js [--bot BotTest] [--minutes 5] [--rounds 3] [--at 0,200] [--r 30] [--kit shield|noshield|none] [--feed no]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeArena, cmd, ask, logSize, logSince } = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const BOT = args.bot || 'BotTest'
const MINUTES = parseFloat(args.minutes || '5')
const ROUNDS = parseInt(args.rounds || '3', 10)
const [CX, CZ] = (args.at || '0,200').split(',').map(Number)
const FEED = args.feed !== 'no'
const arena = makeArena({ cx: CX, cz: CZ, r: parseInt(args.r || '30', 10), dark: true })

// Iron armour (from prepare), a sword (and shield) in hand, a bow and food in the bag;
// none: bare-handed, no armour, nothing in the bag.
const GEAR_BAG = [['bow', 1], ['arrow', 32], ['cooked_beef', 8]]
const KITS = {
  shield: { hands: [['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']], bag: GEAR_BAG },
  noshield: { hands: [['weapon.mainhand', 'iron_sword']], bag: GEAR_BAG },
  none: { armor: false, hands: [], bag: [] }
}
const KIT = KITS[args.kit || 'shield']
// How often to count the monsters in the arena.
const CENSUS_MS = 10000
const MONSTERS = ['zombie', 'husk', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'zombie_villager', 'drowned', 'phantom']

const DATA = process.env.IONGOLEM_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'iongolem')
const RESULTS = path.join(DATA, 'duel', 'survival-results.jsonl')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const DEATH_RE = new RegExp(`System chat: (${BOT} (?:was|died|drowned|fell|hit the|burned|went up|tried|walked|experienced|blew|withered|starved|suffocated|froze)[^\\n]*)`)

const health = async () => {
  const r = await ask(`data get entity ${BOT} Health`, new RegExp(`${BOT} has the following entity data: [\\d.]+f|No entity was found`))
  const m = r && r.match(/([\d.]+)f/)
  return m ? +(+m[1]).toFixed(1) : null
}
// Monsters in the arena right now, by kind (kinds with none left out).
async function census() {
  const out = {}
  for (const m of MONSTERS) {
    const r = await ask(`execute if entity @e[type=${m},${arena.box}]`, /Test passed\. Count: \d+|Test failed/)
    const n = r && r.match(/Count: (\d+)/)
    if (n) out[m] = +n[1]
  }
  return out
}

// What the bot did between two wall-clock times, from its own log (lines stamped HH:MM:SS.mmm).
function botActions(t0, t1) {
  const dir = path.join(DATA, BOT, 'logs')
  const latest = fs.readdirSync(dir).filter(f => f.startsWith('bot-')).sort().pop()
  const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8)
  const [a, b] = [hhmmss(t0), hhmmss(t1)]
  const lines = fs.readFileSync(path.join(dir, latest), 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    .filter(l => { const t = l.slice(0, 8); return a <= b ? t >= a && t <= b : t >= a || t <= b })
  const count = (re) => lines.filter(l => re.test(l)).length
  const actions = {}
  for (const l of lines) {
    const m = l.match(/\[BG\] launching: ([a-z_]+)(?::([a-z_]+))?/)
    if (m) { const k = m[2] ? `${m[1]}:${m[2]}` : m[1]; actions[k] = (actions[k] || 0) + 1 }
  }
  const hitBy = {}
  for (const l of lines) { const m = l.match(/\[AUTO\] hit by ([a-z_]+)/); if (m) hitBy[m[1]] = (hitBy[m[1]] || 0) + 1 }
  return { actions, hitBy, kills: count(/ killed!/), shield: count(/\[SHIELD\] up/), juke: count(/\[DODGE\]/), sidestep: count(/\[PROJ\] .*→ sidestep/) }
}

async function playRound(n) {
  await arena.sweep()
  await arena.prepare(BOT, 'blue', KIT, 0)
  await cmd(`tp ${BOT} ${CX + 0.5} 151 ${CZ + 0.5}`)
  if (FEED) await cmd(`effect give ${BOT} saturation 1 10 true`)
  await sleep(500)
  const from = logSize()
  const t0 = Date.now(), until = t0 + MINUTES * 60000
  let died = null, nextCensus = t0
  const peak = {}, counts = []
  while (Date.now() < until) {
    const m = logSince(from).match(DEATH_RE)
    if (m) { died = m[1]; break }
    if (Date.now() >= nextCensus) {
      const c = await census()
      counts.push(Object.values(c).reduce((a, b) => a + b, 0))
      for (const [k, v] of Object.entries(c)) peak[k] = Math.max(peak[k] || 0, v)
      nextCensus += CENSUS_MS
    }
    await sleep(500)
  }
  const t1 = Date.now()
  const result = {
    t: new Date().toISOString(), round: n, bot: BOT, kit: args.kit || 'shield', fed: FEED, minutes: MINUTES,
    survived: !died, seconds: +((t1 - t0) / 1000).toFixed(1), death: died,
    hp: died ? 0 : await health(),
    monstersAvg: counts.length ? +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1) : 0,
    monstersPeak: peak,
    ...botActions(t0, t1)
  }
  console.log(`Round ${n}: ${died ? `DIED at ${result.seconds}s (${died})` : `SURVIVED ${MINUTES} min, hp ${result.hp}`} — ` +
    `monsters avg ${result.monstersAvg}, peak ${JSON.stringify(peak)}; kills ${result.kills}; hit by ${JSON.stringify(result.hitBy)}; ` +
    `actions ${JSON.stringify(result.actions)}; shield ${result.shield}, juke ${result.juke}, sidestep ${result.sidestep}`)
  fs.appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  if (died) await sleep(3000)   // respawn on the roof before the next round's teleport
  return result
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  // Where the bot was, to put it back afterwards; refused if that's inside an arena.
  const pos = await ask(`data get entity ${BOT} Pos`, new RegExp(`${BOT} has the following entity data: \\[[^\\]]+\\]|No entity was found`))
  const home = pos && pos.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
  if (!home) { console.error(`${BOT} is not online`); process.exit(1) }
  console.log(`Dark arena at ${CX},${CZ} (r ${arena.r}): ${await arena.ready()}; spectate from ${arena.VIEW.x} ${arena.VIEW.y} ${arena.VIEW.z}`)

  const results = []
  for (let n = 1; n <= ROUNDS; n++) results.push(await playRound(n))

  const survived = results.filter(r => r.survived).length
  const avg = (k) => (results.reduce((a, r) => a + (r[k] || 0), 0) / results.length).toFixed(1)
  console.log(`\n== ${BOT} survived ${survived} of ${results.length} rounds of ${MINUTES} min ==`)
  console.log(`avg time alive ${avg('seconds')}s, avg monsters ${avg('monstersAvg')}, avg kills ${avg('kills')}`)
  console.log(`results appended to ${RESULTS}`)

  await arena.sweep()
  const [x, y, z] = home.slice(1)
  await cmd(`tp ${BOT} ${x} ${y} ${z}`)
  await cmd(`spawnpoint ${BOT} ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`)
  await cmd(`team leave ${BOT}`)
}

main().catch(e => { console.error(e); process.exit(1) })
