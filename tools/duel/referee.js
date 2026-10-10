// Duel referee: builds the arena, starts the fighters, and runs rounds to the
// death. Red and blue are teams: each entry of --red/--blue is one fighter running
// that strategy from strategies/ in its kit. A side wins when the whole other side
// is dead (the dead sit out the round on the roof); the clock running out is a
// draw. Each round is appended to <data dir>/duel/results.jsonl so strategy
// versions can be compared over time.
//
//   node tools/duel/referee.js [--red archer-v0,archer-v0] [--blue swordsman-v0] [--rounds 5] [--time 60]
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
const TEAM = { red: (args.red || 'archer-v0').split(','), blue: (args.blue || 'swordsman-v0').split(',') }
const LABEL = { red: TEAM.red.join('+'), blue: TEAM.blue.join('+') }
// BotRed, or BotRed1, BotRed2, … for a team.
const nameOf = (side, i) => `Bot${side[0].toUpperCase()}${side.slice(1)}${TEAM[side].length > 1 ? i + 1 : ''}`

const DATA = process.env.IONGOLEM_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'iongolem')
const RESULTS = path.join(DATA, 'duel', 'results.jsonl')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A fighter child and a queue of its messages.
function spawnFighter(side, slot) {
  const name = nameOf(side, slot)
  const strategy = TEAM[side][slot]
  const child = fork(path.join(__dirname, 'fighter.js'), [name, strategy])
  const f = { side, slot, name, strategy, child, inbox: [], waiters: [] }
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
  await Promise.all(fighters.map(f => next(f, 'ready')))
  await arena.sweep()
  // Corners in turn across the sides: red 1, blue 1, red 2, blue 2, …
  const order = [...fighters].sort((a, b) => a.slot - b.slot || SIDES.indexOf(a.side) - SIDES.indexOf(b.side))
  for (const [n, f] of order.entries()) await arena.prepare(f.name, f.side, f.kit, n)
  await sleep(1500)   // let kits, health and the teleport reach the clients
  for (const f of fighters) drop(f, 'died')

  console.log(`\nRound ${n}: red ${LABEL.red} vs blue ${LABEL.blue}`)
  const t0 = Date.now()
  for (const f of fighters) {
    f.child.send({ type: 'start', opponents: fighters.filter(o => o.side !== f.side).map(o => o.name) })
  }

  // Deaths as they come, until a side is wiped out or time runs out.
  const dead = new Map()   // fighter → its stats at death
  const alive = (side) => fighters.filter(f => f.side === side && !dead.has(f))
  let timer
  const clock = new Promise(resolve => { timer = setTimeout(resolve, TIME_MS) })
  await new Promise(resolve => {
    for (const f of fighters) {
      next(f, 'died').then(s => {
        if (dead.size === fighters.length) return
        dead.set(f, s)
        console.log(`  ${f.name} (${f.strategy}) died at ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        if (SIDES.some(side => alive(side).length === 0)) resolve()
      })
    }
    clock.then(resolve)
  })
  clearTimeout(timer)
  const ms = Date.now() - t0
  // Unanswered 'died' waiters belong to this round: drop them, or a fighter's next
  // death resolves this round's waiter instead of the next round's.
  for (const f of fighters) f.waiters = f.waiters.filter(w => w.type !== 'died')

  // The survivors report their stats on stop; the dead already reported in 'died'.
  const stats = new Map(dead)
  for (const f of fighters) {
    if (dead.has(f)) continue
    f.child.send({ type: 'stop' })
    stats.set(f, await next(f, 'stats'))
    f.inbox.push({ type: 'ready' })   // still on the arena floor
  }

  const winner = SIDES.find(side => alive(side).length > 0 && SIDES.every(o => o === side || alive(o).length === 0)) || 'draw'
  const result = {
    t: new Date().toISOString(), round: n, red: LABEL.red, blue: LABEL.blue,
    winner, seconds: +(ms / 1000).toFixed(1)
  }
  for (const side of SIDES) {
    const team = fighters.filter(f => f.side === side)
    result[`${side}Hp`] = +team.reduce((a, f) => a + stats.get(f).hp, 0).toFixed(1)
    result[`${side}Hits`] = team.reduce((a, f) => a + stats.get(f).hitsDealt, 0)
    result[`${side}Alive`] = alive(side).length
  }
  console.log(`  ${winner === 'draw' ? 'DRAW (time)' : `${winner.toUpperCase()} (${LABEL[winner]}) WINS`} in ${result.seconds}s — ` +
    `alive red ${result.redAlive} / blue ${result.blueAlive}, hp red ${result.redHp} / blue ${result.blueHp}, ` +
    `hits landed red ${result.redHits} / blue ${result.blueHits}`)
  fs.appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  return result
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  console.log('Building arena…')
  await arena.build()
  const fighters = SIDES.flatMap(side => TEAM[side].map((_, i) => spawnFighter(side, i)))

  const results = []
  for (let n = 1; n <= ROUNDS; n++) results.push(await playRound(n, fighters))

  const wins = (side) => results.filter(x => x.winner === side).length
  const avg = (k) => (results.reduce((a, x) => a + x[k], 0) / results.length).toFixed(1)
  console.log(`\n== red ${LABEL.red} ${wins('red')} : ${wins('blue')} ${LABEL.blue} blue ` +
    `(${wins('draw')} draws) ==`)
  console.log(`avg round ${avg('seconds')}s, avg hits landed red ${avg('redHits')} / blue ${avg('blueHits')}`)
  console.log(`results appended to ${RESULTS}`)

  for (const f of fighters) { f.child.removeAllListeners('exit'); f.child.send({ type: 'quit' }) }
  await sleep(1000)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
