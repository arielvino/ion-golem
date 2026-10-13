// Bridge probe: does a walk bridge a gap it can't walk around, and only then? Builds
// two sky platforms 5 blocks apart through the console FIFO, puts the bot on one and
// sends it `!act goto` to the other, round after round. Scenes:
//   gap       — open air between them, cobblestone in the bot's inventory;
//   noblocks  — the same with nothing to bridge with;
//   off       — the same with `!bridge off`;
//   detour    — a walkway around the gap (about 6 blocks longer than straight across).
// A barrier net 6 below catches a fall. Each round reads from the bot's log how the goto
// ended and how many blocks the walk placed.
//
// The bot under test is a quiet one with its output in --out:
//   node bot.js BotGhast --debug --no-ai --no-chat > /tmp/botghast.out 2>&1
//
//   node tools/bridge-probe.js [--scene gap] [--rounds 5] [--bot BotGhast] [--out /tmp/botghast.out]
const fs = require('fs')
const { cmd } = require('./duel/arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const BOT = args.bot || 'BotGhast'
const OUT = args.out || '/tmp/botghast.out'
const SCENE = args.scene || 'gap'
const ROUNDS = parseInt(args.rounds || '5', 10)
const TIME_MS = 60000
const X = 30000, Y = 200, Z = 30100
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const say = (text) => cmd(`tellraw ${BOT} {"text":"<Sargon564> ${text}"}`)

// Start platform x X-3..X+3, z Z-2..Z+2; target z Z-12..Z-8; gap z Z-7..Z-3.
async function stage() {
  // The start floor stays put (the bot stands on it); everything else is rebuilt.
  await cmd(`fill ${X - 3} ${Y} ${Z - 2} ${X + 3} ${Y} ${Z + 2} stone`)
  await cmd(`fill ${X - 6} ${Y + 1} ${Z - 2} ${X + 6} ${Y + 6} ${Z + 4} air`)
  await cmd(`fill ${X - 6} ${Y - 5} ${Z - 14} ${X + 6} ${Y + 6} ${Z - 3} air`)
  await cmd(`fill ${X - 6} ${Y - 6} ${Z - 14} ${X + 6} ${Y - 6} ${Z + 4} barrier`)
  await cmd(`fill ${X - 3} ${Y} ${Z - 12} ${X + 3} ${Y} ${Z - 8} stone`)
  if (SCENE === 'detour') await cmd(`fill ${X + 3} ${Y} ${Z - 7} ${X + 3} ${Y} ${Z - 3} stone`)
  for (const t of ['item']) await cmd(`kill @e[type=${t},x=${X},y=${Y},z=${Z},distance=..30]`)
  await cmd(`clear ${BOT}`)
  await cmd(`tp ${BOT} ${X + 0.5} ${Y + 1} ${Z + 0.5} 180 0`)
  await cmd(`item replace entity ${BOT} weapon.mainhand with iron_pickaxe`)
  if (SCENE !== 'noblocks') await cmd(`give ${BOT} cobblestone 16`)
  await cmd(`effect give ${BOT} instant_health 1 10 true`)
  await sleep(2500)   // the bot sees both platforms before it plans
}

function botLog(from) {
  return fs.readFileSync(OUT).subarray(from).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
}

async function playRound(n) {
  await stage()
  const from = fs.statSync(OUT).size
  const t0 = Date.now()
  await say(`!act goto:${X},${Y + 1},${Z - 10}`)
  let end = null
  while (Date.now() - t0 < TIME_MS && !end) {
    await sleep(500)
    end = botLog(from).map(l => l.match(/\[BG\] finished: goto:\S+ → (\w+)/)).find(Boolean)
  }
  const lines = botLog(from)
  const r = {
    n, status: end ? end[1] : 'timeout', seconds: +((Date.now() - t0) / 1000).toFixed(1),
    bridged: lines.filter(l => /pathfinder: bridged with/.test(l)).length,
    why: (lines.map(l => l.match(/nav: (.*)/)).filter(Boolean).pop() || [])[1] || ''
  }
  console.log(`#${n}: ${r.status} after ${r.seconds}s, bridged ${r.bridged}${r.why ? ` (${r.why})` : ''}`)
  return r
}

async function main() {
  if (SCENE === 'off') { await say('!bridge off'); await sleep(500) }
  const results = []
  for (let n = 1; n <= ROUNDS; n++) results.push(await playRound(n))
  if (SCENE === 'off') await say('!bridge on')
  const ok = results.filter(r => r.status === 'done')
  const avg = (rs, k) => rs.length ? (rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(1) : '-'
  console.log(`\n== ${SCENE}: arrived ${ok.length}/${ROUNDS} (avg ${avg(ok, 'seconds')}s); bridged ${avg(results, 'bridged')} blocks per round ==`)
}

main().catch(e => { console.error(e); process.exit(1) })
