// Route A/B: one goto over the same terrain, run after run, under different modes. The
// terrain in --box is saved once (cloned --backup-dx blocks east, in the same dimension)
// and put back before every run, so what a run digs or bridges doesn't reach the next.
// Modes alternate (A B A B …); a mode is a list of chat commands sent before its runs:
//   --modes "!dig on|!dig off"  (default)  — `|` between modes, `;` between commands.
// Each run reads from the bot's log how the goto ended, how long it took, how many blocks
// the walk dug and placed, and how many plans the pathfinder made (and of them, partial).
//
// The bot under test is a quiet one with its output in --out:
//   node bot.js BotGhast --debug --no-ai --no-chat > /tmp/botghast.out 2>&1
//
//   node tools/route-ab.js --dim the_nether --from 37,56,-97 --to -20,61,-110 \
//     --box -32,40,-122,49,85,-85 [--backup-dx 2000] [--rounds 3] [--modes "…"]
const fs = require('fs')
const { cmd } = require('./duel/arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split(' --').filter(Boolean)
  .map(a => { const [k, ...v] = a.replace(/^--/, '').trim().split(/\s+/); return [k, v.join(' ').replace(/^"|"$/g, '')] }))
const BOT = args.bot || 'BotGhast'
const OUT = args.out || '/tmp/botghast.out'
const DIM = `minecraft:${args.dim || 'overworld'}`
const FROM = args.from.split(',').map(Number)
const TO = args.to
const [x1, y1, z1, x2, y2, z2] = args.box.split(',').map(Number)
const DX = parseInt(args['backup-dx'] || '2000', 10)
const ROUNDS = parseInt(args.rounds || '3', 10)
const MODES = (args.modes || '!dig on|!dig off').split('|').map(m => m.split(';').map(s => s.trim()).filter(Boolean))
const TIME_MS = 150000
const SLICE = 8                // x columns per clone: 8 × the box's y × z stays under the block limit
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const inDim = (c) => cmd(`execute in ${DIM} run ${c}`)
const say = (text) => cmd(`tellraw ${BOT} {"text":"<Sargon564> ${text}"}`)

async function copyBox(fromDx, toDx) {
  for (let x = x1; x <= x2; x += SLICE) {
    const xe = Math.min(x + SLICE - 1, x2)
    await inDim(`clone ${x + fromDx} ${y1} ${z1} ${xe + fromDx} ${y2} ${z2} ${x + toDx} ${y1} ${z1} replace force`)
  }
}

function botLog(from) {
  return fs.readFileSync(OUT).subarray(from).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
}

async function run(n, mode) {
  for (const c of mode) await say(c)
  await copyBox(DX, 0)        // the terrain as saved
  await inDim(`kill @e[type=!player,x=${x1},y=${y1},z=${z1},dx=${x2 - x1},dy=${y2 - y1},dz=${z2 - z1}]`)
  await cmd(`clear ${BOT}`)
  await inDim(`tp ${BOT} ${FROM[0] + 0.5} ${FROM[1]} ${FROM[2] + 0.5}`)
  await cmd(`item replace entity ${BOT} weapon.mainhand with iron_pickaxe`)
  await cmd(`give ${BOT} cobblestone 27`)
  await cmd(`effect give ${BOT} fire_resistance 300 0 true`)
  await cmd(`effect give ${BOT} resistance 300 4 true`)
  await sleep(4000)           // chunks in, vision has looked around
  const from = fs.statSync(OUT).size
  const t0 = Date.now()
  await say(`!act goto:${TO}`)
  let end = null
  while (Date.now() - t0 < TIME_MS && !end) {
    await sleep(500)
    end = botLog(from).map(l => l.match(/\[BG\] finished: goto:\S+ → (\w+)/)).find(Boolean)
  }
  const lines = botLog(from)
  const count = (re) => lines.filter(l => re.test(l)).length
  const r = {
    n, mode: mode.join('; '), status: end ? end[1] : 'timeout', seconds: +((Date.now() - t0) / 1000).toFixed(1),
    dug: count(/pathfinder: dug /), placed: count(/pathfinder: bridged with/),
    plans: count(/pathfinder: plan /), partial: count(/pathfinder: plan partial/),
    fallback: count(/falling back to cardinalWalk/),
    why: (lines.map(l => l.match(/nav: (?!starting)(.*)/)).filter(Boolean).pop() || [])[1] || ''
  }
  console.log(`#${n} [${r.mode}]: ${r.status} after ${r.seconds}s; dug ${r.dug}, placed ${r.placed}; ` +
    `plans ${r.plans} (${r.partial} partial)${r.fallback ? ', fell back to cardinalWalk' : ''}${r.why ? ` — ${r.why}` : ''}`)
  return r
}

async function main() {
  await inDim(`forceload add ${x1} ${z1} ${x2} ${z2}`)
  await inDim(`forceload add ${x1 + DX} ${z1} ${x2 + DX} ${z2}`)
  await sleep(3000)
  const mark = `/tmp/route-ab-${DIM.split(':')[1]}-${args.box}.saved`
  if (!fs.existsSync(mark)) { await copyBox(0, DX); fs.writeFileSync(mark, new Date().toISOString()); console.log('terrain saved') }
  const results = []
  for (let n = 1; n <= ROUNDS; n++) for (const mode of MODES) results.push(await run(n, mode))
  await say('!dig on'); await say('!bridge on')
  console.log('')
  for (const mode of MODES) {
    const rs = results.filter(r => r.mode === mode.join('; '))
    const ok = rs.filter(r => r.status === 'done')
    const avg = (xs, k) => xs.length ? (xs.reduce((a, r) => a + r[k], 0) / xs.length).toFixed(1) : '-'
    console.log(`== [${mode.join('; ')}]: arrived ${ok.length}/${rs.length} (avg ${avg(ok, 'seconds')}s); per run dug ${avg(rs, 'dug')}, ` +
      `placed ${avg(rs, 'placed')}, plans ${avg(rs, 'plans')} (${avg(rs, 'partial')} partial) ==`)
  }
  await copyBox(DX, 0)
  await inDim(`forceload remove ${x1} ${z1} ${x2} ${z2}`)
  await inDim(`forceload remove ${x1 + DX} ${z1} ${x2 + DX} ${z2}`)
}

main().catch(e => { console.error(e); process.exit(1) })
