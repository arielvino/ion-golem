// Ghast probe: how often a test bot deflects a ghast's fireball. A still ghast (NoAI)
// hangs off a sky platform; each trial summons one fireball the way a ghast fires it
// (4 blocks out from its centre, aimed at the bot, starting at 0.1 b/t and
// accelerating) with the ghast as its owner, then reads from the bot's log whether it
// deflected the ball or was hit, and checks whether the ghast died to its own ball.
// Deflecting is what counts; killing the ghast with it is a bonus.
//
// The bot under test is a quiet one with its output in --out:
//   node bot.js BotGhast --debug --no-ai --no-chat > /tmp/botghast.out 2>&1
//
//   node tools/duel/ghast-probe.js [--act attack:ghast] [--lead 1] [--bot BotGhast] [--out /tmp/botghast.out] [--trials 20] [--d 20] [--up 8] [--gap 4]
const fs = require('fs')
const { cmd, ask } = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const BOT = args.bot || 'BotGhast'
const OUT = args.out || '/tmp/botghast.out'
const TRIALS = parseInt(args.trials || '20', 10)
const D = parseFloat(args.d || '20')       // ghast's horizontal distance
const UP = parseFloat(args.up || '8')      // ghast's height above the bot's feet
const ACT = args.act || null   // an action to have running when the ball comes (attack:ghast, eat)
const LEAD = parseFloat(args.lead || '1') * 1000
const GAP = parseFloat(args.gap || '4') * 1000
const X = 30000, Y = 200, Z = 30000
const UUID = '[I;77,77,77,77]'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const ghast = { x: X + 0.5, y: Y + 1 + UP, z: Z + 0.5 - D }
async function ghastAlive() {
  return /passed/.test(await ask(`execute if entity @e[type=ghast,tag=probeghast]`, /Test (passed|failed)/) || '')
}
async function stage() {
  await cmd(`fill ${X - 5} ${Y} ${Z - 5} ${X + 5} ${Y} ${Z + 5} stone`)
  await cmd(`fill ${X - 4} ${Y + 1} ${Z - 4} ${X + 4} ${Y + 6} ${Z + 4} air`)
  await cmd(`fill ${X - 5} ${Y + 1} ${Z - 5} ${X + 5} ${Y + 2} ${Z + 5} barrier hollow`)
  await cmd(`fill ${X - 4} ${Y + 1} ${Z - 4} ${X + 4} ${Y + 2} ${Z + 4} air`)
  await cmd(`tp ${BOT} ${X + 0.5} ${Y + 1} ${Z + 0.5}`)
  await cmd(`effect give ${BOT} instant_health 1 10 true`)
  if (ACT === 'eat') await cmd(`effect give ${BOT} hunger 3 255 true`)   // something to eat for
  else await cmd(`effect give ${BOT} saturation 1 10 true`)
  await cmd(`effect give ${BOT} fire_resistance 30 0 true`)
  if (!await ghastAlive()) {
    await cmd(`summon ghast ${ghast.x} ${ghast.y} ${ghast.z} {NoAI:1b,PersistenceRequired:1b,UUID:${UUID},Tags:["probeghast"],Rotation:[0f,0f]}`)
  }
}

async function fire() {
  // Vanilla: from the ghast's centre plus 4 blocks along its view, aimed at the
  // target's middle; a hurting projectile starts at its acceleration power.
  const from = { x: ghast.x, y: ghast.y + 2, z: ghast.z }
  const to = { x: X + 0.5, y: Y + 1 + 0.9, z: Z + 0.5 }
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const n = Math.hypot(d.x, d.y, d.z)
  const u = { x: d.x / n, y: d.y / n, z: d.z / n }
  const p = { x: from.x + u.x * 4, y: from.y + u.y * 4, z: from.z + u.z * 4 }
  const m = [u.x, u.y, u.z].map(c => (c * 0.1).toFixed(5) + 'd').join(',')
  await cmd(`summon fireball ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)} {Motion:[${m}],acceleration_power:0.1d,ExplosionPower:1b,Owner:${UUID}}`)
}

async function main() {
  const results = []
  for (let n = 1; n <= TRIALS; n++) {
    await stage()
    await sleep(1500)
    const from = fs.statSync(OUT).size
    if (ACT) { await cmd(`tellraw ${BOT} {"text":"<Tester> !act ${ACT}"}`); await sleep(LEAD) }
    await fire()
    await sleep(GAP)
    const log = fs.readFileSync(OUT, 'utf8').slice(from).replace(/\x1b\[[0-9;]*m/g, '')
    const r = { n, deflected: /\[PROJ\] returned fireball/.test(log), killed: !await ghastAlive(), hit: /\[AUTO\] hit by fireball/.test(log) }
    results.push(r)
    console.log(`#${n}: ${r.deflected ? 'deflected' : 'not deflected'}${r.killed ? ', killed the ghast' : ''}${r.hit ? ', HIT me' : ''}`)
  }
  const c = (k) => results.filter(r => r[k]).length
  console.log(`\n== ${TRIALS} fireballs at ${D}m/${UP}up${ACT ? ` while ${ACT}` : ''}: deflected ${c('deflected')} (${c('killed')} killed the ghast), hit me ${c('hit')} ==`)
  await cmd(`kill @e[type=ghast,tag=probeghast]`)
}

main().catch(e => { console.error(e); process.exit(1) })
