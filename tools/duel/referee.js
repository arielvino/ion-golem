// Duel referee: builds the arena, starts a hunter and a defender, and runs rounds.
// The hunter wins by killing the defender before time runs out; the defender wins
// by surviving (or by killing the hunter). Each round is appended to
// <data dir>/duel/results.jsonl so strategy versions can be compared over time.
//
//   node tools/duel/referee.js [--rounds 5] [--time 60] [--hunter hunter-v0] [--defender defender-v0]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { fork } = require('child_process')
const arena = require('./arena')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map(a => a.trim().split(/\s+/)))
const ROUNDS = parseInt(args.rounds || '5', 10)
const TIME_MS = parseInt(args.time || '60', 10) * 1000
const NAMES = { hunter: 'BotHunter', defender: 'BotDefender' }
const STRATEGY = { hunter: args.hunter || 'hunter-v0', defender: args.defender || 'defender-v0' }

const DATA = process.env.IONGOLEM_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'iongolem')
const RESULTS = path.join(DATA, 'duel', 'results.jsonl')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A fighter child and a queue of its messages.
function spawnFighter(role) {
  const child = fork(path.join(__dirname, 'fighter.js'), [NAMES[role], STRATEGY[role]])
  const f = { role, name: NAMES[role], child, inbox: [], waiters: [] }
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

async function playRound(n, hunter, defender) {
  await Promise.all([next(hunter, 'ready'), next(defender, 'ready')])
  await arena.sweep()
  await arena.prepare(hunter.name, 'hunter')
  await arena.prepare(defender.name, 'defender')
  await sleep(1500)   // let kits, health and the teleport reach the clients
  drop(hunter, 'died'); drop(defender, 'died')

  console.log(`\nRound ${n}: ${hunter.name} (${STRATEGY.hunter}) vs ${defender.name} (${STRATEGY.defender})`)
  const t0 = Date.now()
  hunter.child.send({ type: 'start', role: 'hunter', opponent: defender.name })
  defender.child.send({ type: 'start', role: 'defender', opponent: hunter.name })

  const outcome = await Promise.race([
    next(defender, 'died').then(s => ({ winner: 'hunter', how: 'kill', dead: 'defender', s })),
    next(hunter, 'died').then(s => ({ winner: 'defender', how: 'kill', dead: 'hunter', s })),
    sleep(TIME_MS).then(() => ({ winner: 'defender', how: 'timeout' }))
  ])
  const ms = Date.now() - t0

  // The survivors report their stats on stop; a dead fighter already reported in 'died'.
  const stats = {}
  for (const f of [hunter, defender]) {
    if (outcome.dead === f.role) { stats[f.role] = outcome.s; continue }
    f.child.send({ type: 'stop' })
    stats[f.role] = await next(f, 'stats')
  }
  // A survivor still on the arena floor is "ready" for the next round.
  for (const f of [hunter, defender]) if (outcome.dead !== f.role) f.inbox.push({ type: 'ready' })

  const result = {
    t: new Date().toISOString(), round: n, hunter: STRATEGY.hunter, defender: STRATEGY.defender,
    winner: outcome.winner, how: outcome.how, seconds: +(ms / 1000).toFixed(1),
    hunterHp: +stats.hunter.hp.toFixed(1), defenderHp: +stats.defender.hp.toFixed(1),
    hunterHits: stats.hunter.hitsDealt, defenderHits: stats.defender.hitsDealt
  }
  console.log(`  ${result.winner.toUpperCase()} wins by ${result.how} in ${result.seconds}s — ` +
    `hp H ${result.hunterHp} / D ${result.defenderHp}, hits landed H ${result.hunterHits} / D ${result.defenderHits}`)
  fs.appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  return result
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  console.log('Building arena…')
  await arena.build()
  const hunter = spawnFighter('hunter')
  const defender = spawnFighter('defender')

  const results = []
  for (let n = 1; n <= ROUNDS; n++) results.push(await playRound(n, hunter, defender))

  const wins = (r) => results.filter(x => x.winner === r).length
  const avg = (k) => (results.reduce((a, x) => a + x[k], 0) / results.length).toFixed(1)
  console.log(`\n== ${STRATEGY.hunter} ${wins('hunter')} : ${wins('defender')} ${STRATEGY.defender} ==`)
  console.log(`avg round ${avg('seconds')}s, avg hits landed H ${avg('hunterHits')} / D ${avg('defenderHits')}`)
  console.log(`results appended to ${RESULTS}`)

  for (const f of [hunter, defender]) { f.child.removeAllListeners('exit'); f.child.send({ type: 'quit' }) }
  await sleep(1000)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
