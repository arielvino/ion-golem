// Reach probe: what a test bot's hit reflex does about a mob it can or can't walk up
// to, round after round. The mob is NoAI, so it stays where it was put; the hits come
// from the console (`damage <bot> 1 mob_attack by <mob>`, every few seconds while it
// lives), which the bot sees exactly as a hit from that mob. Scenes, built through
// the console FIFO on sky platforms (1-high rim, so the bot sees over it):
//   ghast     — a ghast 20 blocks out and 8 up (out of reach);
//   blaze     — a blaze 8 out and 5 up (out of reach);
//   blaze-low — a blaze 3 out and 1 up (in reach: melee, as before);
//   gap       — a skeleton on another platform 12 off and 3 down, open air between;
//   bridge    — the same, with a bridge across (in reach: melee, as before).
// The bot gets iron armour, a sword and shield, plus the --kit: bow (and arrows),
// trident (Loyalty), trident-plain (no Loyalty), or none. Each round reads from the
// bot's log what the reflex chose and how the round went.
//
// The bot under test is a quiet one with its output in --out:
//   node bot.js BotGhast --debug --no-ai --no-chat > /tmp/botghast.out 2>&1
//
//   node tools/duel/reach-probe.js [--scene ghast] [--kit bow] [--rounds 10] [--time 30] [--bot BotGhast] [--out /tmp/botghast.out]
const fs = require('fs')
const { cmd, ask } = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const BOT = args.bot || 'BotGhast'
const OUT = args.out || '/tmp/botghast.out'
const SCENE = args.scene || 'ghast'
const KIT = args.kit || 'bow'
const ROUNDS = parseInt(args.rounds || '10', 10)
const TIME_MS = parseFloat(args.time || '30') * 1000
const PULSE_MS = 3000
const X = 30000, Y = 200, Z = 30000
const TAG = 'reachprobe'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Where the mob goes, relative to the bot's feet at X+.5, Y+1, Z+.5.
const SCENES = {
  ghast: { mob: 'ghast', at: [0, 8, -20] },
  blaze: { mob: 'blaze', at: [0, 5, -8] },
  'blaze-low': { mob: 'blaze', at: [0, 1, -3] },
  gap: { mob: 'skeleton', at: [0, -3, -12], ledge: true },
  bridge: { mob: 'skeleton', at: [0, -3, -12], ledge: true, bridge: true }
}
const S = SCENES[SCENE]
const KITS = {
  bow: [['bow', 1], ['arrow', 64]],
  trident: [['trident[enchantments={loyalty:3}]', 1]],
  'trident-plain': [['trident', 1]],
  none: []
}

async function mobAlive() {
  return /passed/.test(await ask(`execute if entity @e[tag=${TAG}]`, /Test (passed|failed)/) || '')
}
async function health() {
  const r = await ask(`data get entity ${BOT} Health`, /has the following entity data: [\d.]+f|No entity was found/)
  const m = r && r.match(/([\d.]+)f/)
  return m ? +(+m[1]).toFixed(1) : 0
}

// A stone floor of radius r (barrier under it), cleared above, with a 1-high rim.
async function platform(x, y, z, r) {
  await cmd(`fill ${x - r - 1} ${y - 1} ${z - r - 1} ${x + r + 1} ${y - 1} ${z + r + 1} barrier`)
  await cmd(`fill ${x - r - 1} ${y} ${z - r - 1} ${x + r + 1} ${y} ${z + r + 1} stone`)
  await cmd(`fill ${x - r - 1} ${y + 1} ${z - r - 1} ${x + r + 1} ${y + 10} ${z + r + 1} air`)
  // The rim as its four sides: `fill … hollow` on a 1-high box fills all of it, and
  // the floor flashed with barrier until the next fill cleared it.
  const a = r + 1
  for (const [x1, z1, x2, z2] of [[-a, -a, a, -a], [-a, a, a, a], [-a, -a, -a, a], [a, -a, a, a]]) {
    await cmd(`fill ${x + x1} ${y + 1} ${z + z1} ${x + x2} ${y + 1} ${z + z2} barrier`)
  }
}

async function stage() {
  await cmd(`kill @e[tag=${TAG}]`)
  for (const t of ['item', 'arrow', 'trident']) await cmd(`kill @e[type=${t},x=${X},y=${Y},z=${Z},distance=..40]`)
  // Clear what an earlier scene left, then build this one.
  await cmd(`fill ${X - 6} ${Y - 5} ${Z - 16} ${X + 6} ${Y + 12} ${Z + 6} air`)
  await platform(X, Y, Z, 4)
  const [dx, dy, dz] = S.at
  if (S.ledge) {
    await platform(X + dx, Y + dy, Z + dz, 2)
    // Open the bot's rim toward the ledge, which is lower: the rim hid the skeleton.
    await cmd(`setblock ${X} ${Y + 1} ${Z - 5} air`)
    // Open the ledge's rim where the bridge meets it, and lay it: steps down from the
    // bot's platform to the ledge.
    if (S.bridge) {
      await cmd(`setblock ${X} ${Y + dy + 1} ${Z + dz + 3} air`)
      for (let k = 0; k < 4; k++) await cmd(`setblock ${X} ${Y - k} ${Z - 6 - k} stone`)
    }
  }
  await cmd(`clear ${BOT}`)
  await cmd(`tp ${BOT} ${X + 0.5} ${Y + 1} ${Z + 0.5} 180 0`)
  await cmd(`spawnpoint ${BOT} ${X} ${Y + 1} ${Z}`)
  await cmd(`item replace entity ${BOT} weapon.mainhand with iron_sword`)
  await cmd(`item replace entity ${BOT} weapon.offhand with shield`)
  for (const [slot, item] of [['head', 'iron_helmet'], ['chest', 'iron_chestplate'], ['legs', 'iron_leggings'], ['feet', 'iron_boots']]) {
    await cmd(`item replace entity ${BOT} armor.${slot} with ${item}`)
  }
  for (const [item, n] of KITS[KIT]) await cmd(`give ${BOT} ${item} ${n}`)
  await cmd(`effect clear ${BOT}`)
  await cmd(`effect give ${BOT} instant_health 1 10 true`)
  await cmd(`effect give ${BOT} saturation 1 10 true`)
  await sleep(1500)
  // A helmet, or the skeleton burns to death in daylight and the round counts it killed.
  const gear = S.mob === 'skeleton'
    ? 'equipment:{mainhand:{id:"minecraft:bow",count:1},head:{id:"minecraft:leather_helmet",count:1}},' : ''
  await cmd(`summon ${S.mob} ${X + 0.5 + dx} ${Y + 1 + dy} ${Z + 0.5 + dz} {NoAI:1b,PersistenceRequired:1b,${gear}Tags:["${TAG}"]}`)
  await sleep(1000)   // in the bot's view before the first hit
}

// From byte `from` (a file size): other players' chat in it isn't all one byte a character.
function botLog(from) {
  return fs.readFileSync(OUT).subarray(from).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
}

async function playRound(n) {
  // From before the mob appears: defend mode may engage it during the stage.
  const from = fs.statSync(OUT).size
  await stage()
  const t0 = Date.now()
  let killed = false, lastPulse = 0
  while (Date.now() - t0 < TIME_MS) {
    if (!await mobAlive()) { killed = true; break }
    if (Date.now() - lastPulse >= PULSE_MS) {
      lastPulse = Date.now()
      await cmd(`damage ${BOT} 1 minecraft:mob_attack by @e[tag=${TAG},limit=1]`)
    }
    await sleep(200)
  }
  const seconds = +((Date.now() - t0) / 1000).toFixed(1)
  const hp = await health()
  const lines = botLog(from)
  const count = (re) => lines.filter(l => re.test(l)).length
  // What the reflex launched (attack:… or shoot:…), or why it didn't fight back.
  const choices = lines.map(l => (l.match(/\[BG\] launching: ((?:attack|shoot):\S+)/) || l.match(/not fighting back: (.*)/) || [])[1])
    .filter(Boolean).map(c => c.replace(/#[0-9a-f]+/, ''))
  const r = {
    n, killed, seconds, hp, choices: [...new Set(choices)],
    shots: count(/\[(BOW|CROSSBOW|TRIDENT)\] shot \d+/), shotHits: count(/\[(BOW|CROSSBOW|TRIDENT)\] shot \d+ .*→ HIT/),
    meleeGaveUp: count(/gave up the chase/)
  }
  console.log(`#${n}: ${killed ? 'KILLED' : 'alive'} after ${seconds}s, ${BOT} hp ${hp}; reflex ${r.choices.join(' | ') || 'none'}; ` +
    `shots ${r.shots} (${r.shotHits} hit), melee gave up ${r.meleeGaveUp}`)
  return r
}

async function main() {
  const results = []
  for (let n = 1; n <= ROUNDS; n++) results.push(await playRound(n))
  const killed = results.filter(r => r.killed)
  const avg = (rs, k) => rs.length ? (rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(1) : '-'
  console.log(`\n== ${SCENE}, kit ${KIT}: killed ${killed.length}/${ROUNDS} (avg ${avg(killed, 'seconds')}s); ` +
    `shots ${avg(results, 'shots')} (${avg(results, 'shotHits')} hit), melee gave up ${avg(results, 'meleeGaveUp')}, hp left ${avg(results, 'hp')} per round ==`)
  await cmd(`kill @e[tag=${TAG}]`)
}

main().catch(e => { console.error(e); process.exit(1) })
