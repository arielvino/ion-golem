// Duel referee: builds the arena, starts two fighters, and runs rounds to the
// death. Red and blue each run a strategy from strategies/ in that strategy's kit;
// a kill wins the round, the clock running out is a draw. Each round is appended
// to <data dir>/duel/results.jsonl so strategy versions can be compared over time.
//
//   node tools/duel/referee.js [--red archer-v0] [--blue swordsman-v0] [--rounds 5] [--time 60]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { fork } = require('child_process')
const arena = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const ROUNDS = parseInt(args.rounds || '5', 10)
const TIME_MS = parseInt(args.time || '60', 10) * 1000
const SIDES = ['red', 'blue']
const NAMES = { red: 'BotRed', blue: 'BotBlue' }
const STRATEGY = { red: args.red || 'archer-v0', blue: args.blue || 'swordsman-v0' }

const DATA = process.env.IONGOLEM_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'iongolem')
const RESULTS = path.join(DATA, 'duel', 'results.jsonl')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A fighter child and a queue of its messages.
function spawnFighter(side) {
  const child = fork(path.join(__dirname, 'fighter.js'), [NAMES[side], STRATEGY[side]])
  const f = { side, name: NAMES[side], strategy: STRATEGY[side], child, inbox: [], waiters: [] }
  f.kit = require(path.join(__dirname, 'strategies', f.strategy)).kit
  child.on('message', (m) => {
    const i = f.waiters.findIndex(w => w.type === m.type)
    if (i >= 0) f.waiters.splice(i, 1)[0].resolve(m)
    else f.inbox.push(m)
  })
  child.on('exit', (code) => { console.error(`${f.name} exited (${code})`); process.exit(1) })
  return f
}

// The next message of `type` from f (queued or future).
function next(f, type) {
  const i = f.inbox.findIndex(m => m.type === type)
  if (i >= 0) return Promise.resolve(f.inbox.splice(i, 1)[0])
  return new Promise(resolve => f.waiters.push({ type, resolve }))
}

function drop(f, type) { f.inbox = f.inbox.filter(m => m.type !== type) }

async function playRound(n, fighters) {
  const [a, b] = fighters
  await Promise.all(fighters.map(f => next(f, 'ready')))
  await arena.sweep()
  for (const f of fighters) await arena.prepare(f.name, f.side, f.kit)
  await sleep(1500)   // let kits, health and the teleport reach the clients
  for (const f of fighters) drop(f, 'died')

  console.log(`\nRound ${n}: ${a.name} (${a.strategy}) vs ${b.name} (${b.strategy})`)
  const t0 = Date.now()
  a.child.send({ type: 'start', opponent: b.name })
  b.child.send({ type: 'start', opponent: a.name })

  const outcome = await Promise.race([
    ...fighters.map(f => next(f, 'died').then(s => ({ dead: f, s }))),
    sleep(TIME_MS).then(() => ({}))
  ])
  const ms = Date.now() - t0
  // The other side's 'died' waiter lost the race: drop it, or that fighter's next
  // death resolves this stale waiter instead of the next round's.
  for (const f of fighters) f.waiters = f.waiters.filter(w => w.type !== 'died')

  // The survivors report their stats on stop; a dead fighter already reported in 'died'.
  const stats = {}
  for (const f of fighters) {
    if (outcome.dead === f) { stats[f.side] = outcome.s; continue }
    f.child.send({ type: 'stop' })
    stats[f.side] = await next(f, 'stats')
    f.inbox.push({ type: 'ready' })   // still on the arena floor
  }

  const winner = outcome.dead ? fighters.find(f => f !== outcome.dead) : null
  const result = {
    t: new Date().toISOString(), round: n, red: STRATEGY.red, blue: STRATEGY.blue,
    winner: winner ? winner.side : 'draw', winnerStrategy: winner ? winner.strategy : null,
    seconds: +(ms / 1000).toFixed(1)
  }
  for (const side of SIDES) {
    result[`${side}Hp`] = +stats[side].hp.toFixed(1)
    result[`${side}Hits`] = stats[side].hitsDealt
  }
  console.log(`  ${winner ? `${winner.strategy} (${winner.side}) KILLS` : 'DRAW (time)'} in ${result.seconds}s — ` +
    `hp red ${result.redHp} / blue ${result.blueHp}, hits landed red ${result.redHits} / blue ${result.blueHits}`)
  fs.appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  return result
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  console.log('Building arena…')
  await arena.build()
  const fighters = SIDES.map(spawnFighter)

  const results = []
  for (let n = 1; n <= ROUNDS; n++) results.push(await playRound(n, fighters))

  const wins = (side) => results.filter(x => x.winner === side).length
  const avg = (k) => (results.reduce((a, x) => a + x[k], 0) / results.length).toFixed(1)
  console.log(`\n== red ${STRATEGY.red} ${wins('red')} : ${wins('blue')} ${STRATEGY.blue} blue ` +
    `(${wins('draw')} draws) ==`)
  console.log(`avg round ${avg('seconds')}s, avg hits landed red ${avg('redHits')} / blue ${avg('blueHits')}`)
  console.log(`results appended to ${RESULTS}`)

  for (const f of fighters) { f.child.removeAllListeners('exit'); f.child.send({ type: 'quit' }) }
  await sleep(1000)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
